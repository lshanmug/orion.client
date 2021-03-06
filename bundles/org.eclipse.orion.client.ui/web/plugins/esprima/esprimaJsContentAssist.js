/*******************************************************************************
 * @license
 * Copyright (c) 2012 VMware, Inc. All Rights Reserved.
 * Copyright (c) 2013 IBM Corporation.
 *
 * THIS FILE IS PROVIDED UNDER THE TERMS OF THE ECLIPSE PUBLIC LICENSE
 * ("AGREEMENT"). ANY USE, REPRODUCTION OR DISTRIBUTION OF THIS FILE
 * CONSTITUTES RECIPIENTS ACCEPTANCE OF THE AGREEMENT.
 * You can obtain a current copy of the Eclipse Public License from
 * http://www.opensource.org/licenses/eclipse-1.0.php
 *
 * Contributors:
 *	 Andy Clement (VMware) - initial API and implementation
 *	 Andrew Eisenberg (VMware) - implemented visitor pattern
 *       Manu Sridharan (IBM) - Various improvements
 ******************************************************************************/

/*global define esprima doctrine */
define(["plugins/esprima/esprimaVisitor", "plugins/esprima/typesFromIndexFile", "plugins/esprima/typeUtils", "plugins/esprima/proposalUtils", "plugins/esprima/scriptedLogger", "orion/Deferred", "esprima/esprima"],
		function(mVisitor, mTypes, typeUtils, proposalUtils, scriptedLogger, Deferred) {

	/**
	 * TODO move this to a central location
	 * @type {function(obj):Boolean} a safe way of checking for arrays
	 */
	var isArray = Array.isArray;
	if (!isArray) {
		isArray = function isArray(ary) {
			return Object.prototype.toString.call(ary) === '[object Array]';
		};
	}

	var RESERVED_WORDS = {
		"break" : true, "case" : true, "catch" : true, "continue" : true, "debugger" : true, "default" : true, "delete" : true, "do" : true, "else" : true, "finally" : true,
		"for" : true, "function" : true, "if" : true, "in" : true, "instanceof" : true, "new" : true, "return" : true, "switch" : true, "this" : true, "throw" : true, "try" : true, "typeof" : true,
		"var" : true, "void" : true, "while" : true, "with" : true
	};
	function isReserverdWord(name) {
		return RESERVED_WORDS[name] === true;
	}

	/**
	 * @param {String} char a string of at least one char14acter
	 * @return {boolean} true iff uppercase ascii character
	 */
	function isUpperCaseChar(c) {
		if (c.length < 1) {
			return false;
		}
		var charCode = c.charCodeAt(0);
		if (isNaN(charCode)) {
			return false;
		}
		return charCode >= 65 && charCode <= 90;
	}

	/**
	 * finds the right-most segment of a dotted MemberExpression
	 * if it is an identifier, or null otherwise
	 * @return {{name:String}}
	 */
	function findRightMost(node) {
		if (!node) {
			return null;
		} else if (node.type === "Identifier") {
			return node;
		} else if (node.type === "MemberExpression") {
			if (node.computed) {
				if (node.property.type === "Literal" && typeof node.property.value === "string") {
					return node.property;
				} else {
					// an array access
					return node;
				}
			} else {
				return findRightMost(node.property);
			}
		} else if (node.type === "ArrayExpression") {
			return node;
		} else {
			return null;
		}
	}

	/**
	 * Recursively generates a name based on the given expression
	 * @param {{type:String,name:String}} node
	 * @return {String}
	 */
	function findDottedName(node) {
		if (!node) {
			return "";
		} else if (node.type === "Identifier") {
			return node.name;
		} else if (node.type === "MemberExpression") {
			var left = findDottedName(node.object);
			var right = findDottedName(node.property);
			if (left.length > 0 && right.length > 0) {
				return left + "." + right;
			}
			return left + right;
		} else if (node.type === "CallExpression") {
			return findDottedName(node.callee);
		} else {
			return "";
		}
	}

	/**
	 * Convert an array of parameters into a string and also compute linked editing positions
	 * @param {String} name name of the function
	 * @param {{}} typeObj the type object of the function
	 * @param {Number} offset offset
	 * @return {{ completion:String, positions:[Number] }}
	 */
	function calculateFunctionProposal(name, typeObj, offset) {
		var params = typeObj.params || [];

		var positions = [];
		var completion = name + '(';
		var plen = params.length;
		for (var p = 0; p < plen; p++) {
			if (params[p].name === 'new' || params[p].name === 'this') {
				continue;
			}
			if (p > 0) {
				completion += ', ';
			}
			var param = params[p];
			var optional, rest;
			if (param.type === 'OptionalType') {
				param = param.expression;
				optional=true;
			}

			if (param.type === 'RestType') {
				param = param.expression;
				rest = true;
			}

			var argName = param.name || 'arg' + p;
			if (rest) {
				argName = '...' + argName;
			}
			if (optional) {
				argName = '[' + argName + ']';
			}
			positions.push({offset:offset+completion.length+1, length: argName.length});
			completion += argName;
		}
		completion += ')';
		return {completion: completion, positions: positions.length === 0 ? null : positions};
	}

	/**
	 * checks that offset overlaps with the given range
	 * Since esprima ranges are zero-based, inclusive of
	 * the first char and exclusive of the last char, must
	 * use a +1 at the end.
	 * eg- (^ is the line start)
	 *	   ^x	---> range[0,0]
	 *	   ^  xx ---> range[2,3]
	 */
	function inRange(offset, range, includeEdge) {
		return range[0] <= offset && (includeEdge ? range[1] >= offset : range[1] > offset);
	}
	/**
	 * checks that offset is before the range
	 * @return Boolean
	 */
	function isBefore(offset, range) {
		if (!range) {
			return true;
		}
		return offset < range[0];
	}

	/**
	 * Determines if the offset is inside this member expression, but after the '.' and before the
	 * start of the property.
	 * eg, the following returns true:
	 *   foo   .^bar
	 *   foo   .  ^ bar
	 * The following returns false:
	 *   foo   ^.  bar
	 *   foo   .  b^ar
	 * @return Boolean
	 */
	function afterDot(offset, memberExpr, contents) {
		// check for broken AST
		var end;
		if (memberExpr.property) {
			end = memberExpr.property.range[0];
		} else {
			// no property expression, use the end of the memberExpr as the end to look at
			// in this case assume that the member expression ends just after the dot
			// this allows content assist invocations to work on the member expression when there
			// is no property
			end = memberExpr.range[1] + 2;
		}
		// we are not considered "after" the dot if the offset
		// overlaps with the property expression or if the offset is
		// after the end of the member expression
		if (!inRange(offset-1, memberExpr.range) ||
			inRange(offset-1, memberExpr.object.range) ||
			offset > end) {
			return false;
		}

		var dotLoc = memberExpr.object.range[1];
		while (contents.charAt(dotLoc) !== "." && dotLoc < end) {
			dotLoc++;
		}

		if (contents.charAt(dotLoc) !== ".") {
			return false;
		}

		return dotLoc < offset;
	}

	/**
	 * @return "top" if we are at a start of a new expression fragment (eg- at an empty line,
	 * or a new parameter).  "member" if we are after a dot in a member expression.  false otherwise
	 * @return {Boolean|String}
	 */
	function shouldVisit(root, offset, prefix, contents) {
		/**
		 * A visitor that finds the parent stack at the given location
		 * @param node the AST node being visited
		 * @param parents stack of parent nodes for the current node
		 * @param isInitialVisit true iff this is the first visit of the node, false if this is
		 *   the end visit of the node
		 */
		var findParent = function(node, parents, isInitialVisit) {
			// extras prop is where we stuff everything that we have added
			if (!node.extras) {
				node.extras = {};
			}

			if (!isInitialVisit) {

				// if we have reached the end of an inRange block expression then
				// this means we are completing on an empty expression
				if (node.type === "Program" || (node.type === "BlockStatement") &&
						inRange(offset, node.range)) {
					throw "done";
				}

				parents.pop();
				// return value is ignored
				return false;
			}

			// the program node is always in range even if the range numbers do not line up
			if ((node.range && inRange(offset-1, node.range)) || node.type === "Program") {
				if (node.type === "Identifier") {
					throw "done";
				}
				parents.push(node);
				if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") &&
						node.nody && isBefore(offset, node.body.range)) {
					// completion occurs on the word "function"
					throw "done";
				}
				// special case where we are completing immediately after a '.'
				if (node.type === "MemberExpression" && !node.property && afterDot(offset, node, contents)) {
					throw "done";
				}
				return true;
			} else {
				return false;
			}
		};
		var parents = [];
		try {
			mVisitor.visit(root, parents, findParent, findParent);
		} catch (done) {
			if (done !== "done") {
				// a real error
				throw(done);
			}
		}

		// determine if we need to defer infering the enclosing function block
		var toDefer;
		if (parents && parents.length) {
			var parent = parents.pop();
			for (var i = 0; i < parents.length; i++) {
				if ((parents[i].type === "FunctionDeclaration" || parents[i].type === "FunctionExpression") &&
						// don't defer if offset is over the function name
						!(parents[i].id && inRange(offset, parents[i].id.range, true))) {
					toDefer = parents[i];
					break;
				}

			}

			if (parent.type === "MemberExpression") {
				if (parent.property && inRange(offset-1, parent.property.range)) {
					// on the right hand side of a property, eg: foo.b^
					return { kind : "member", toDefer : toDefer };
				} else if (inRange(offset-1, parent.range) && afterDot(offset, parent, contents)) {
					// on the right hand side of a dot with no text after, eg: foo.^
					return { kind : "member", toDefer : toDefer };
				}
			} else if (parent.type === "Program" || parent.type === "BlockStatement") {
				// completion at a new expression
				if (!prefix) {
				}
			} else if (parent.type === "VariableDeclarator" && (!parent.init || isBefore(offset, parent.init.range))) {
				// the name of a variable declaration
				return false;
			} else if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") &&
					isBefore(offset, parent.body.range)) {
				// a function declaration
				return false;
			}
		}
		return { kind : "top", toDefer : toDefer };
	}

	/**
	 * finds the final return statement of a function declaration
	 * @param node an ast statement node
	 * @return the lexically last ReturnStatment AST node if there is one, else
	 * null if there is no return statement
	 */
	function findReturn(node) {
		if (!node) {
			return null;
		}
		var type = node.type, maybe, i, last;
		// since we are finding the last return statement, start from the end
		switch(type) {
		case "BlockStatement":
			if (node.body && node.body.length > 0) {
				last = node.body[node.body.length-1];
				if (last.type === "ReturnStatement") {
					return last;
				} else {
					return findReturn(last);
				}
			}
			return null;
		case "WhileStatement":
		case "DoWhileStatement":
		case "ForStatement":
		case "ForInStatement":
		case "CatchClause":

			return findReturn(node.body);
		case "IfStatement":
			maybe = findReturn(node.alternate);
			if (!maybe) {
				maybe = findReturn(node.consequent);
			}
			return maybe;
		case "TryStatement":
			maybe = findReturn(node.finalizer);
			var handlers = node.handlers;
			if (!maybe && handlers) {
				// start from the last handler
				for (i = handlers.length-1; i >= 0; i--) {
					maybe = findReturn(handlers[i]);
					if (maybe) {
						break;
					}
				}
			}
			if (!maybe) {
				maybe = findReturn(node.block);
			}
			return maybe;
		case "SwitchStatement":
			var cases = node.cases;
			if (cases) {
				// start from the last handler
				for (i = cases.length-1; i >= 0; i--) {
					maybe = findReturn(cases[i]);
					if (maybe) {
						break;
					}
				}
			}
			return maybe;
		case "SwitchCase":
			if (node.consequent && node.consequent.length > 0) {
				last = node.consequent[node.consequent.length-1];
				if (last.type === "ReturnStatement") {
					return last;
				} else {
					return findReturn(last);
				}
			}
			return null;

		case "ReturnStatement":
			return node;
		default:
			// don't visit nested functions
			// expression statements, variable declarations,
			// or any other kind of node
			return null;
		}
	}

	/**
	 * updates a function type to include a new return type.
	 * makes a copy of the functiontype
	 * TODO this is not a deep copy...should it be?
	 * TOD move to mTypes
	 */
	function updateReturnType(originalFunctionTypeObj, newReturnTypeObj) {
		if (! originalFunctionTypeObj || originalFunctionTypeObj.type !== "FunctionType") {
			return newReturnTypeObj;
		} else {
			var newFunctionTypeObj = {
				type: originalFunctionTypeObj.type,
				params: originalFunctionTypeObj.params,
				result: newReturnTypeObj
			};
			if (originalFunctionTypeObj['this']) {
				newFunctionTypeObj['this'] = originalFunctionTypeObj['this'];
			}
			if (originalFunctionTypeObj['new']) {
				newFunctionTypeObj['new'] = originalFunctionTypeObj['new'];
			}
			return newFunctionTypeObj;
		}
	}
	/**
	 * checks to see if this file looks like an AMD module
	 * Assumes that there are one or more calls to define at the top level
	 * and the first statement is a define call
	 * @return true iff there is a top-level call to 'define'
	 */
	function checkForAMD(node) {
		var body = node.body;
		if (body && body.length >= 1 && body[0]) {
			if (body[0].type === "ExpressionStatement" &&
				body[0].expression &&
				body[0].expression.type === "CallExpression" &&
				body[0].expression.callee.name === "define") {

				// found it.
				return body[0].expression;
			}
		}
		return null;
	}
	/**
	 * checks to see if this file looks like a wrapped commonjs module
	 * Assumes that there are one or more calls to define at the top level
	 * and the first statement is a define call
	 * @return true iff there is a top-level call to 'define'
	 */
	function checkForCommonjs(node) {
		var body = node.body;
		if (body && body.length >= 1) {
			for (var i = 0; i < body.length; i++) {
				if (body[i] &&
					body[i].type === "ExpressionStatement" &&
					body[i].expression &&
					body[i].expression.type === "CallExpression" &&
					body[i].expression.callee.name === "define") {

					var callee = body[i].expression;
					if (callee["arguments"] &&
						callee["arguments"].length === 1 &&
						callee["arguments"][0].type === "FunctionExpression" &&
						callee["arguments"][0].params.length === 3) {

						var params = callee["arguments"][0].params;
						if (params[0].name === "require" &&
							params[1].name === "exports" &&
							params[2].name === "module") {

							// found it.
							return body[i].expression;
						}
					}
				}
			}
		}
		return null;
	}

	/**
	 * if this method call ast node is a call to require with a single string constant
	 * argument, then look that constant up in the indexer to get a summary
	 * if a summary is found, then apply it to the current scope
	 */
	function extractRequireModule(call, env) {
		if (!env.indexer) {
			return;
		}
		if (call.type === "CallExpression" && call.callee.type === "Identifier" &&
			call.callee.name === "require" && call["arguments"].length === 1) {

			var arg = call["arguments"][0];
			if (arg.type === "Literal" && typeof arg.value === "string") {
				// we're in business
				var summary = env.indexer.retrieveSummary(arg.value);
				if (summary) {
					var typeName;
					var mergeTypeName;
					if (typeof summary.provided === "string") {
						mergeTypeName = typeName = summary.provided;
					} else {
						// module provides a composite type
						// must create a type to add the summary to
						mergeTypeName = typeName = env.newScope();
						env.popScope();
					}
					env.mergeSummary(summary, mergeTypeName);
					return typeUtils.ensureTypeObject(typeName);
				}
			}
		}

		return;
	}

	/**
	 * checks to see if this function is a module definition
	 * and if so returns an array of module definitions
	 *
	 * if this is not a module definition, then just return an array of Object for each typ
	 */
	function findModuleDefinitions(fnode, env) {
		var paramTypes = [], params = fnode.params, i;
		if (params.length > 0) {
			if (!fnode.extras) {
				fnode.extras = {};
			}
			if (env.indexer && fnode.extras.amdDefn) {
				var args = fnode.extras.amdDefn["arguments"];
				// the function definition must be the last argument of the call to define or require
				if (args.length > 1 && args[args.length-1] === fnode) {
					// the module names could be the first or second argument
					var moduleNames = null;
					if (args.length === 3 && args[0].type === "Literal" && args[1].type === "ArrayExpression") {
						moduleNames = args[1].elements;
					} else if (args.length === 2 && args[0].type === "ArrayExpression") {
						moduleNames = args[0].elements;
					}
					if (moduleNames) {
						for (i = 0; i < params.length; i++) {
							if (i < moduleNames.length && moduleNames[i].type === "Literal") {
								// resolve the module name from the indexer
								var summary = env.indexer.retrieveSummary(moduleNames[i].value);
								if (summary) {
									var typeName;
									var mergeTypeName;
									if (typeof summary.provided === "string") {
										mergeTypeName = typeName = summary.provided;
									} else {
										// module provides a composite type
										// must create a type to add the summary to
										mergeTypeName = typeName = env.newScope();
										env.popScope();
									}
									env.mergeSummary(summary, mergeTypeName);
									paramTypes.push(typeName);
								} else {
									paramTypes.push(env.newFleetingObject());
								}
							} else {
								paramTypes.push(typeUtils.OBJECT_TYPE);
							}
						}
					}
				}
			}
		}
		if (paramTypes.length === 0) {
			for (i = 0; i < params.length; i++) {
				paramTypes.push(env.newFleetingObject());
			}
		}
		return paramTypes;
	}


	/**
	 * Finds the closest doc comment to this node
	 * @param {{range:Array.<Number>}} node
	 * @param {Array.<{range:Array.<Number>}>} doccomments
	 * @return {{value:String,range:Array.<Number>}}
	 */
	function findAssociatedCommentBlock(node, doccomments) {
		// look for closest doc comment that is before the start of this node
		// just shift all the other ones
		var candidate;
		while (doccomments.length > 0 && doccomments[0].range[0] < node.range[0]) {
			candidate = doccomments.shift();
		}
		return candidate || { value : null };
	}


	/**
	 * Extracts all doccomments that fall inside the given range.
	 * Side effect is to remove the array elements
	 * @param Array.<{range:Array.<Number}>> doccomments
	 * @param Array.<Number> range
	 * @return {{value:String,range:Array.<Number>}} array elements that are removed
	 */
	function extractDocComments(doccomments, range) {
		var start = 0, end = 0, i, docStart, docEnd;
		for (i = 0; i < doccomments.length; i++) {
			docStart = doccomments[i].range[0];
			docEnd = doccomments[i].range[1];
			if (!isBefore(docStart, range) || !isBefore(docEnd, range)) {
				break;
			}
		}

		if (i < doccomments.length) {
			start = i;
			for (i = i; i < doccomments.length; i++) {
				docStart = doccomments[i].range[0];
				docEnd = doccomments[i].range[1];
				if (!inRange(docStart, range, true) || !inRange(docEnd, range, true)) {
					break;
				}
			}
			end = i;
		}

		return doccomments.splice(start, end-start);
	}

	/**
	 * This function takes the current AST node and does the first inferencing step for it.
	 * @param node the AST node to visit
	 * @param env the context for the visitor.  See computeProposals below for full description of contents
	 */
	function inferencer(node, env) {
		var type = node.type, name, i, property, params, newTypeObj, jsdocResult, jsdocType, docComment;

		// extras prop is where we stuff everything that we have added
		if (!node.extras) {
			node.extras = {};
		}

		switch(type) {
		case "Program":
			// check for module kind
			env.commonjsModule = checkForCommonjs(node);
			if (!env.commonjsModule) {
				// can't be both amd and commonjs
				env.amdModule = checkForAMD(node);
			}
			break;
		case "BlockStatement":
			node.extras.inferredTypeObj = env.newScopeObj();
			if (node.extras.stop) {
				// this BlockStatement inferencing is deferred until after the rest of the file is inferred
				inferencerPostOp(node, env);
				delete node.extras.stop;
				return false;
			}
			break;
		case "Literal":
			break;
		case "ArrayExpression":
			node.extras.inferredTypeObj = typeUtils.ARRAY_TYPE;
			break;
		case "ObjectExpression":
			if (node.extras.fname) {
				// this object expression is contained inside another object expression
				env.pushName(node.extras.fname);
			}

			// for object literals, create a new object type so that we can stuff new properties into it.
			// we might be able to do better by walking into the object and inferring each RHS of a
			// key-value pair
			newTypeObj = env.newObject(null, node.range);
			node.extras.inferredTypeObj = newTypeObj;
			for (i = 0; i < node.properties.length; i++) {
				property = node.properties[i];
				// only remember if the property is an identifier
				if (property.key && property.key.name) {
					// first just add as an object property (or use jsdoc if exists).
					// after finishing the ObjectExpression, go and update
					// all of the variables to reflect their final inferred type
					docComment = findAssociatedCommentBlock(property.key, env.comments);
					jsdocResult = typeUtils.parseJSDocComment(docComment);
					jsdocType = jsdocResult.type && typeUtils.convertJsDocType(jsdocResult.type, env);
					if (!property.key.extras) {
						property.key.extras = {};
					}
					var keyType;
					if (jsdocType) {
						property.key.extras.inferredType = property.key.extras.jsdocType = keyType = jsdocType;
					} else {
						keyType = typeUtils.OBJECT_TYPE;
					}
					env.addVariable(property.key.name, node, keyType, property.key.range, docComment.range);
					property.key.extras.associatedComment = docComment;
					// remember that this is the LHS so that we don't add the identifier to global scope
					property.key.extras.isLHS = property.key.extras.isDecl = true;

					if (property.value.type === "FunctionExpression" || property.value.type === "ObjectExpression") {
						if (!property.value.extras) {
							property.value.extras = {};
						}
						// RHS is a function, remember the name in case it is a constructor
						property.value.extras.fname = property.key.name;
						property.value.extras.cname = env.getQualifiedName() + property.key.name;

						if (property.value.type === "FunctionExpression") {
							// now remember the jsdocResult so it doesn't need to be recomputed
							property.value.extras.jsdocResult = jsdocResult;
						}
					}
				}
			}
			break;
		case "FunctionDeclaration":
		case "FunctionExpression":
			var nameRange;
			if (node.id) {
				// true for function declarations
				name = node.id.name;
				nameRange = node.id.range;
			} else if (node.extras.fname) {
				// true for rhs of assignment to function expression
				name = node.extras.fname;
				nameRange = node.range;
			}
			params = [];
			if (node.params) {
				for (i = 0; i < node.params.length; i++) {
					params[i] = node.params[i].name;
				}
			}

			if (node.extras.jsdocResult) {
				jsdocResult = node.extras.jsdocResult;
				docComment = { range : null };
			} else {
				docComment = node.extras.associatedComment || findAssociatedCommentBlock(node, env.comments);
				jsdocResult = typeUtils.parseJSDocComment(docComment);
			}

			// assume that function name that starts with capital is
			// a constructor
			var isConstructor;
			if (name && node.body && isUpperCaseChar(name)) {
				if (node.extras.cname) {
					// RHS of assignment
					name = node.extras.cname;
				}
				// a new object for "this" is created inside the initFunctionType
				// call below
				newTypeObj = typeUtils.createNameType(name);
				isConstructor = true;
			} else {
				if (jsdocResult.rturn) {
					var jsdocReturn = typeUtils.convertJsDocType(jsdocResult.rturn, env);
					// keep track of the return type for the way out
					node.extras.jsdocReturn = jsdocReturn;
					newTypeObj = jsdocReturn;
					node.extras.inferredTypeObj = jsdocReturn;
				} else {
					// temporarily use "undefined" as type, but this may change once we
					// walk through to get to a return statement
					newTypeObj = typeUtils.UNDEFINED_TYPE;
				}
				isConstructor = false;
			}

			var callArgs = new Array(params.length);
			if (node.extras.paramTypeObj && node.extras.paramTypeObj.type === 'FunctionType') {
				// this function is an anonymous function being passed as an argument
				// to another function and we have a hint of what the function type is
				// shunt the argument types to this function's arguments
				var paramTypes = node.extras.paramTypeObj.params;
				var len = Math.min(params.length || 0, paramTypes.length || 0);
				for (var i = 0; i < len; i++) {
					callArgs[i] = paramTypes[i];
				}
			}
			if (!node.body.extras) {
				node.body.extras = {};
			}
			node.body.extras.isConstructor = isConstructor;

			// add parameters to the current scope
			var paramTypeObjs = [];
			if (params.length > 0) {
				var moduleDefs = findModuleDefinitions(node, env);
				for (i = 0; i < params.length; i++) {
					// choose jsdoc tags over module definitions and both of those over call args
					var jsDocParam = jsdocResult.params[params[i]];
					var paramTypeObj = null;
					if (jsDocParam) {
						paramTypeObj = typeUtils.convertJsDocType(jsDocParam, env);
					} else {
						paramTypeObj = moduleDefs[i];
					}
					if (callArgs[i] && leftTypeIsMoreGeneral(paramTypeObj, callArgs[i], env)) {
						// unwrap parameter type since name is probably wrong
						// TODO if param is wrapped in a RestType, then problem
						paramTypeObj = callArgs[i].type === 'ParameterType' ? callArgs[i].expression : callArgs[i];
					}

					paramTypeObjs.push(typeUtils.createParamType(params[i], paramTypeObj));
				}
			}

			var functionTypeObj = typeUtils.createFunctionType(paramTypeObjs, newTypeObj, isConstructor);
			// we use an object to represent the function type, to allow for properties
			var newFunctionType = env.newFleetingObject();
			if (name && !isBefore(env.offset, node.range)) {
				// if we have a name, then add it to the scope.  make sure we add the name
				// *before* calling initFunctionType(), which creates a new scope for within
				// the function
				env.addVariable(name, node.extras.target, newFunctionType, nameRange, docComment.range);
			}
			env.initFunctionType(functionTypeObj,node,newFunctionType,isConstructor ? newTypeObj.name : undefined);
			if (isConstructor) {
				// assume that constructor will be available from global scope using qualified name
				// this is not correct in all cases
				env.addOrSetGlobalVariable(name, newFunctionType, nameRange, docComment.range);
			}

			node.extras.inferredTypeObj = newFunctionType;


			env.addVariable("arguments", node.extras.target, typeUtils.createNameType("Arguments"), node.range);


			// now determine if we need to add 'this'.  If this function has an appliesTo, the we know it is being assigned as a property onto something else
			// the 'something else' is the 'this' type.
			// eg- var obj={};var obj.fun=function() { ... };
			var appliesTo = node.extras.appliesTo;
			if (appliesTo) {
				var appliesToOwner = appliesTo.extras.target;
				if (appliesToOwner) {
					var ownerTypeName = env.scope(appliesToOwner);
					// for the special case of adding to the prototype, we want to make sure that we also add to the 'this' of
					// the instantiated types
					if (typeUtils.isPrototypeName(ownerTypeName)) {
						ownerTypeName = typeUtils.extractReturnType(ownerTypeName);
					}
					env.addVariable("this", node.extras.target, typeUtils.createNameType(ownerTypeName), nameRange, docComment.range);
				}
			}

			// add variables for all parameters
			for (i = 0; i < params.length; i++) {
				env.addVariable(params[i], node.extras.target, paramTypeObjs[i].expression, node.params[i].range);
			}
			break;
		case "VariableDeclarator":
			if (node.id.name) {
				// remember that the identifier is an LHS
				// so, don't create a type for it
				if (!node.id.extras) {
					node.id.extras = {};
				}
				node.id.extras.isLHS = node.id.extras.isDecl = true;
				if (node.init && !node.init.extras) {
					node.init.extras = {};
				}
				if (node.init && node.init.type === "FunctionExpression") {
					// RHS is a function, remember the name in case it is a constructor
					node.init.extras.fname = node.id.name;
					node.init.extras.cname = env.getQualifiedName() + node.id.name;
					node.init.extras.fnameRange = node.id.range;
				} else {
					// not the RHS of a function, check for jsdoc comments
					docComment = findAssociatedCommentBlock(node, env.comments);
					jsdocResult = typeUtils.parseJSDocComment(docComment);
					jsdocType = jsdocResult.type && typeUtils.convertJsDocType(jsdocResult.type, env);
					node.extras.docRange = docComment.range;
					if (jsdocType) {
						node.extras.inferredTypeObj = jsdocType;
						node.extras.jsdocType = jsdocType;
						env.addVariable(node.id.name, node.extras.target, jsdocType, node.id.range, docComment.range);
					}
				}
			}
			env.pushName(node.id.name);
			break;
		case "AssignmentExpression":
			var rightMost = findRightMost(node.left);
			var qualName = env.getQualifiedName() + findDottedName(node.left);
			if (rightMost && (rightMost.type === "Identifier" || rightMost.type === "Literal")) {
				if (!rightMost.extras) {
					rightMost.extras = {};
				}
				if (node.right.type === "FunctionExpression") {
					// RHS is a function, remember the name in case it is a constructor
					if (!node.right.extras) {
						node.right.extras = {};
					}
					node.right.extras.appliesTo = rightMost;
					node.right.extras.fname = rightMost.name;
					node.right.extras.cname = qualName;
					node.right.extras.fnameRange = rightMost.range;

					if (!node.left.extras) {
						node.left.extras = {};
					}
				}
				docComment = findAssociatedCommentBlock(node, env.comments);
				jsdocResult = typeUtils.parseJSDocComment(docComment);
				jsdocType = jsdocResult.type && typeUtils.convertJsDocType(jsdocResult.type, env);
				node.extras.docRange = docComment.range;
				if (jsdocType) {
					node.extras.inferredTypeObj = jsdocType;
					node.extras.jsdocType = jsdocType;
					env.addVariable(rightMost.name, node.extras.target, jsdocType, rightMost.range, docComment.range);
				}
			}
			env.pushName(qualName);
			break;
		case "CatchClause":
			// create a new scope for the catch parameter
			node.extras.inferredTypeObj = env.newScope();
			if (node.param) {
				if (!node.param.extras) {
					node.param.extras = {};
				}
				var inferredTypeObj = typeUtils.createNameType("Error");
				node.param.extras.inferredTypeObj = inferredTypeObj;
				env.addVariable(node.param.name, node.extras.target, inferredTypeObj, node.param.range);
			}
			break;
		case "MemberExpression":
			if (node.property) {
				if (!node.computed ||  // like this: foo.prop
					(node.computed && node.property.type === "Literal" && typeof node.property.value === "string")) {  // like this: foo['prop']

					// keep track of the target of the property expression
					// so that its type can be used as the seed for finding properties
					if (!node.property.extras) {
						node.property.extras = {};
					}
					node.property.extras.target = node.object;
				} else { // like this: foo[prop] or foo[0]
					// do nothing
				}
			}
			break;
		case "CallExpression":
			if (node.callee.name === "define" || node.callee.name === "require") {
				// check for AMD definition
				var args = node["arguments"];
				if (args.length > 1 &&
					args[args.length-1].type === "FunctionExpression" &&
					args[args.length-2].type === "ArrayExpression") {

					// assume definition
					if (!args[args.length-1].extras) {
						args[args.length-1].extras = {};
					}
					args[args.length-1].extras.amdDefn = node;
				}
			} else {
				// the type of the function call may help infer the types of the parameters
				// keep track of that here
				rightMost = findRightMost(node.callee);
				if (rightMost && rightMost.type === "Identifier") {
					rightMost.extras = rightMost.extras || {};
					rightMost.extras.callArgs = node["arguments"];
				}
			}
			break;
		}

		// defer the inferencing of the function's children containing the offset.
		if (node === env.defer) {
			node.extras.associatedComment = findAssociatedCommentBlock(node, env.comments);
			node.extras.inferredTypeObj = node.extras.inferredTypeObj || typeUtils.OBJECT_TYPE; // will be filled in later
			// need to remember the scope to place this function in for later
			node.extras.scope = env.scope(node.extras.target);

			// need to infer the body of this function later
			node.body.extras.stop = true;
		}

		return true;
	}

	/**
	 * called as the post operation for the proposalGenerator visitor.
	 * Finishes off the inferencing and adds all proposals
	 */
	function inferencerPostOp(node, env) {
		var type = node.type, name, inferredTypeObj, newTypeObj, rightMost, kvps, i;

		switch(type) {
		case "Program":
			if (env.defer) {
				// finally, we can infer the deferred target function

				// now use the comments that we deferred until later
				env.comments = env.deferredComments;

				var defer = env.defer;
				env.defer = null;
				env.targetTypeName = null;
				env.pushScope(defer.extras.scope);
				mVisitor.visit(defer.body, env, inferencer, inferencerPostOp);
				env.popScope();
			}

			// in case we haven't stored target yet, do so now.
			env.storeTarget();

			// TODO FIXADE for historical reasons we end visit by throwing exception.  Should chamge
			throw env.targetTypeName;
		case "BlockStatement":
		case "CatchClause":
			if (inRange(env.offset, node.range)) {
				// if we've gotten here and we are still in range, then
				// we are completing as a top-level entity with no prefix
				env.storeTarget();
			}

			env.popScope();
			break;
		case "MemberExpression":
			if (afterDot(env.offset, node, env.contents)) {
				// completion after a dot with no prefix
				env.storeTarget(env.scope(node.object));
			}

			// for arrays, inferred type is the dereferncing of the array type
			// for non-arrays inferred type is the type of the property expression
			if (typeUtils.isArrayType(node.object.extras.inferredTypeObj) && node.computed) {
				// inferred type of expression is the type of the dereferenced array
				node.extras.inferredTypeObj = typeUtils.extractArrayParameterType(node.object.extras.inferredTypeObj);
			} else if (node.computed && node.property && node.property.type !== "Literal") {
				// we don't infer parameterized objects, but we have something like this: 'foo[at]'  just assume type is object
				node.extras.inferredTypeObj = typeUtils.OBJECT_TYPE;
			} else {
				// a regular member expression: foo.bar or foo['bar']
				// node.propery will be null for mal-formed asts
				node.extras.inferredTypeObj = node.property ?
					node.property.extras.inferredTypeObj :
					node.object.extras.inferredTypeObj;
			}
			break;
		case "CallExpression":
			// first check to see if this is a require call
			var fnTypeObj = extractRequireModule(node, env);

			// otherwise, apply the function
			if (!fnTypeObj) {
				fnTypeObj = typeUtils.extractReturnType(env.getFnType(node.callee));
			}
			node.extras.inferredTypeObj = fnTypeObj;
			break;
		case "NewExpression":
			// FIXADE we have a problem here.
			// constructors that are called like this: new foo.Bar()  should have an inferred type of foo.Bar,
			// This ensures that another constructor new baz.Bar() doesn't conflict.  However,
			// we are only taking the final prefix and assuming that it is unique.
			node.extras.inferredTypeObj = env.getNewType(node.callee);
			break;
		case "ObjectExpression":
			// now that we know all the types of the values, use that to populate the types of the keys
			kvps = node.properties;
			for (i = 0; i < kvps.length; i++) {
				if (kvps[i].hasOwnProperty("key")) {
					// only do this for keys that are identifiers
					// set the proper inferred type for the key node
					// and also update the variable
					name = kvps[i].key.name;
					if (name) {
						// now check for the special case where the rhs value is an identifier.
						// we want to shortcut the navigation and go through to the definition
						// of the identifier, BUT only do this if the identifier points to a function
						// and the key and value names match.
						var range = null;
						if (name === kvps[i].value.name) {
							var def = env.lookupTypeObj(kvps[i].value.name, null, true);
							if (def && def.range && (typeUtils.isFunctionOrConstructor(def.typeObj))) {
								range = def.range;
							}
						}
						if (!range) {
							range = kvps[i].key.range;
						}

						inferredTypeObj =  kvps[i].key.extras.jsdocType || kvps[i].value.extras.inferredTypeObj;
						var docComment = kvps[i].key.extras.associatedComment;
						env.addVariable(name, node, inferredTypeObj, range, docComment.range);
						if (inRange(env.offset-1, kvps[i].key.range)) {
							// We found it! rmember for later, but continue to the end of file anyway
							env.storeTarget(env.scope(node));
						}
					}
				}
			}
			// now, we update the types of any function expressions assigned to literal properties,
			// adding all the object literal's properties to each such type.  This is a heuristic
			// based on the likelihood of the literal itself being passed as the 'this' argument
			// to such functions
			for (i = 0; i < kvps.length; i++) {
				if (kvps[i].hasOwnProperty("key")) {
					name = kvps[i].key.name;
					if (name && kvps[i].value.type === "FunctionExpression") {
						env.updateObjLitFunctionType(node,name,kvps[i].value);
					}
				}
			}
			if (node.extras.fname) {
				// this object expression is contained inside another object expression
				env.popName();
			}
			env.popScope();
			break;
		case "LogicalExpression":
		case "BinaryExpression":
			switch (node.operator) {
				case '+':
					// special case: if either side is a string, then result is a string
					if (node.left.extras.inferredTypeObj.name === "String" ||
						node.right.extras.inferredTypeObj.name === "String") {

						node.extras.inferredTypeObj = typeUtils.STRING_TYPE;
					} else {
						node.extras.inferredTypeObj = typeUtils.NUMBER_TYPE;
					}
					break;
				case '-':
				case '/':
				case '*':
				case '%':
				case '&':
				case '|':
				case '^':
				case '<<':
				case '>>':
				case '>>>':
					// Numeric and bitwise operations always return a number
					node.extras.inferredTypeObj = typeUtils.NUMBER_TYPE;
					break;
				case '&&':
				case '||':
					// will be the type of the left OR the right
					// for now arbitrarily choose the left
					node.extras.inferredTypeObj = node.left.extras.inferredTypeObj;
					break;

				case '!==':
				case '!=':
				case '===':
				case '==':
				case '<':
				case '<=':
				case '>':
				case '>=':
					node.extras.inferredTypeObj = typeUtils.BOOLEAN_TYPE;
					break;


				default:
					node.extras.inferredTypeObj = typeUtils.OBJECT_TYPE;
			}
			break;
		case "UpdateExpression":
		case "UnaryExpression":
			if (node.operator === '!') {
				node.extras.inferredTypeObj = typeUtils.BOOLEAN_TYPE;
			} else {
				// includes all unary operations and update operations
				// ++ -- - and ~
				node.extras.inferredTypeObj = typeUtils.NUMBER_TYPE;
			}
			break;
		case "FunctionDeclaration":
		case "FunctionExpression":
			env.popScope();
			if (node.body) {
				var fnameRange;
				if (node.body.extras.isConstructor) {
					if (node.id) {
						fnameRange = node.id.range;
					} else {
						fnameRange = node.extras.fnameRange;
					}

					// now add a reference to the constructor
					env.addOrSetVariable(typeUtils.extractReturnType(node.extras.inferredTypeObj), node.extras.target, node.extras.inferredTypeObj, fnameRange);
				} else {
					// a regular function.  if we don't already know the jsdoc return,
					// try updating to a more explicit return type
					if (!node.extras.jsdocReturn) {
						var returnStatement = findReturn(node.body);
						var returnType;
						if (returnStatement && returnStatement.extras && returnStatement.extras.inferredTypeObj) {
							returnType = returnStatement.extras.inferredTypeObj;
						} else {
							returnType = typeUtils.UNDEFINED_TYPE;
						}
						env.updateReturnType(node.extras.inferredTypeObj, returnType);
					}
					// if there is a name, then update that as well
					var fname;
					if (node.id) {
						// true for function declarations
						fname = node.id.name;
						fnameRange = node.id.range;
					} else if (node.extras.appliesTo) {
						// true for rhs of assignment to function expression
						fname = node.extras.fname;
						fnameRange = node.extras.fnameRange;
					}
					if (fname) {
						env.addOrSetVariable(fname, node.extras.target, node.extras.inferredTypeObj, fnameRange);
					}
				}
			}
			break;
		case "VariableDeclarator":
			if (node.init) {
				inferredTypeObj = node.init.extras.inferredTypeObj;
			} else {
				inferredTypeObj = env.newFleetingObject();
			}
			node.id.extras.inferredTypeObj = inferredTypeObj;
			if (!node.extras.jsdocType) {
				node.extras.inferredTypeObj = inferredTypeObj;
				env.addVariable(node.id.name, node.extras.target, inferredTypeObj, node.id.range, node.extras.docRange);
			}
			if (inRange(env.offset-1, node.id.range)) {
				// We found it! rmember for later, but continue to the end of file anyway
				env.storeTarget(env.scope(node.id.extras.target));
			}
			env.popName();
			break;

		case "Property":
			if (node.key.extras.jsdocType) {
				// use jsdoc instead of whatever we have inferred
				node.extras.inferredTypeObj = node.key.extras.jsdocType;
			} else {
				node.extras.inferredTypeObj = node.key.extras.inferredTypeObj = node.value.extras.inferredTypeObj;
			}
			break;

		case "AssignmentExpression":
			if (node.extras.jsdocType) {
				// use jsdoc instead of whatever we have inferred
				inferredTypeObj = node.extras.jsdocType;
			} else if (node.operator === '=') {
				// standard assignment
				inferredTypeObj = node.right.extras.inferredTypeObj;
			} else {
				// +=, -=, *=, /=, >>=, <<=, >>>=, &=, |=, or ^=.
				if (node.operator === '+=' && node.left.extras.inferredTypeObj.name === 'String') {
					inferredTypeObj = typeUtils.STRING_TYPE;
				} else {
					inferredTypeObj = typeUtils.NUMBER_TYPE;
				}
			}

			node.extras.inferredTypeObj = inferredTypeObj;
			// when we have 'this.that.theOther.f' need to find the right-most identifier
			rightMost = findRightMost(node.left);
			if (rightMost && (rightMost.type === "Identifier" || rightMost.type === "Literal")) {
				name = rightMost.name ? rightMost.name : rightMost.value;
				rightMost.extras.inferredTypeObj = inferredTypeObj;
				env.addOrSetVariable(name, rightMost.extras.target, inferredTypeObj, rightMost.range, node.extras.docRange);
				if (inRange(env.offset-1, rightMost.range)) {
					// We found it! remember for later, but continue to the end of file anyway
					env.storeTarget(env.scope(rightMost.extras.target));
				}
			} else {
				// might be an assignment to an array, like:
				//   foo[at] = bar;
				if (node.left.computed) {
					rightMost = findRightMost(node.left.object);
					if (rightMost && !(rightMost.type === 'Identifier' && rightMost.name === 'prototype')) {
						// yep...now go and update the type of the array
						// (also don't turn refs to prototype into an array. this breaks things)
						var arrayType = typeUtils.parameterizeArray(inferredTypeObj);
						node.left.extras.inferredTypeObj = inferredTypeObj;
						node.left.object.extras.inferredTypeObj = arrayType;
						env.addOrSetVariable(rightMost.name, rightMost.extras.target, arrayType, rightMost.range, node.extras.docRange);
					}
				}
			}
			env.popName();
			break;
		case 'Identifier':
			name = node.name;
			newTypeObj = env.lookupTypeObj(name, node.extras.target);
			if (newTypeObj && !node.extras.isDecl) {
				// name already exists but we are redeclaring it and so not being overridden
				node.extras.inferredTypeObj = newTypeObj;
				if (inRange(env.offset, node.range, true)) {
					// We found it! rmember for later, but continue to the end of file anyway
					env.storeTarget(env.scope(node.extras.target));
				}

				// if this identifier refers to a function call, and we know the argument types, then push on to the arg nodes
				if (node.extras.callArgs) {
					if (newTypeObj.type === 'FunctionType') {
						// match param types with args
						var paramTypes = newTypeObj.params;
						var args = node.extras.callArgs;
						var len = Math.min(args.length || 0, paramTypes.length || 0);
						for (var i = 0; i < len; i++) {
							args[i].extras = args[i].extras || {};
							args[i].extras.paramTypeObj = paramTypes[i].type === 'ParameterType' ? paramTypes[i].expression : paramTypes[i];
						}
					}
				}

				if (node.extras.paramTypeObj) {
					// this identifier is an argument of a function call whose type we know
					if (leftTypeIsMoreGeneral(newTypeObj, node.extras.paramTypeObj, env)) {
						// the param type is more specific, use that one instead of the otherwise inferred type
						node.extras.inferredTypeObj = newTypeObj = node.extras.paramTypeObj;
						env.addOrSetVariable(name, node.extras.target /* should be null */, newTypeObj);
					}
				}

			} else if (!node.extras.isLHS) {
				if (!inRange(env.offset, node.range, true) && !isReserverdWord(name)) {
					// we have encountered a read of a variable/property that we have never seen before

					if (node.extras.target) {
						// this is a property on an object.  just add to the target
						env.addVariable(name, node.extras.target, env.newFleetingObject(), node.range);
					} else {
						// add as a global variable
						node.extras.inferredTypeObj = env.addOrSetGlobalVariable(name, null, node.range).typeObj;
					}
				} else {
					// We found it! rmember for later, but continue to the end of file anyway
					env.storeTarget(env.scope(node.extras.target));
				}
			} else {
				// if this node is an LHS of an assign, don't store target yet,
				// we need to first apply the RHS before applying.
				// This will happen in the enclosing assignment or variable declarator
			}
			break;
		case "ThisExpression":
			node.extras.inferredTypeObj = env.lookupTypeObj("this");
			if (inRange(env.offset-1, node.range)) {
				// We found it! rmember for later, but continue to the end of file anyway
				env.storeTarget(env.scope());
			}
			break;
		case "ReturnStatement":
			if (node.argument) {
				node.extras.inferredTypeObj = node.argument.extras.inferredTypeObj;
			}
			break;

		case "Literal":
			if (node.extras.target && typeof node.value === "string") {
				// we are inside a computed member expression.
				// find the type of the property referred to if exists
				name = node.value;
				newTypeObj = env.lookupTypeObj(name, node.extras.target);
				node.extras.inferredTypeObj = newTypeObj;
			} else if (node.extras.target && typeof node.value === "number") {
				// inside of an array access
				node.extras.inferredTypeObj = typeUtils.NUMBER_TYPE;
			} else {
				var oftype = (typeof node.value);
				node.extras.inferredTypeObj = typeUtils.createNameType(oftype[0].toUpperCase() + oftype.substring(1, oftype.length));
			}
			break;

		case "ConditionalExpression":
			var target = node.consequent ? node.consequent : node.alternate;
			if (target) {
				node.extras.inferredTypeObj = target.extras.inferredTypeObj;
			}
			break;

		case "ArrayExpression":
			// parameterize this array by the type of its first non-null element
			if (node.elements) {
				for (i = 0; i < node.elements.length; i++) {
					if (node.elements[i]) {
						node.extras.inferredTypeObj = typeUtils.parameterizeArray(node.elements[i].extras.inferredTypeObj);
					}
				}
			}
		}

		if (!node.extras.inferredTypeObj) {
			node.extras.inferredTypeObj = typeUtils.OBJECT_TYPE;
		}
	}


	/**
	 * add variable names from inside a lint global directive
	 */
	function addLintGlobals(env, lintOptions) {
		var i, globName;
		if (lintOptions && isArray(lintOptions.global)) {
			for (i = 0; i < lintOptions.global.length; i++) {
				globName = lintOptions.global[i];
				if (!env.lookupTypeObj(globName)) {
					env.addOrSetVariable(globName);
				}
			}
		}
		var comments = env.comments;
		if (comments) {
			for (i = 0; i < comments.length; i++) {
				var range = comments[i].range;
				if (comments[i].type === "Block" && comments[i].value.substring(0, "global".length) === "global") {
					var globals = comments[i].value;
					var splits = globals.split(/\s+/);
					// start with 1 to avoid 'global'
					for (var j = 1; j < splits.length; j++) {
						if (splits[j].length > 0) {
							var colonIdx = splits[j].indexOf(':');
							if (colonIdx >= 0) {
								globName = splits[j].substring(0,colonIdx).trim();
							} else {
								globName = splits[j].trim();
							}
							if (!env.lookupTypeObj(globName)) {
								env.addOrSetVariable(globName, null, null, range);
							}
						}
					}
					break;
				}
			}
		}
	}

	/**
	 * Adds global variables defined in dependencies
	 */
	function addIndexedGlobals(env) {
		// no indexer means that we should not consult indexes for extra type information
		if (env.indexer) {
			// get the list of summaries relevant for this file
			// add it to the global scope
			var summaries = env.indexer.retrieveGlobalSummaries();
			for (var fileName in summaries) {
				if (summaries.hasOwnProperty(fileName)) {
					env.mergeSummary(summaries[fileName], env.globalTypeName());
				}
			}
		}
	}

	/**
	 * the prefix of a completion should not be included in the completion itself
	 * must explicitly remove it
	 */
	function removePrefix(prefix, string) {
		return string.substring(prefix.length);
	}

	function isEmpty(generatedTypeName, allTypes) {
		if (typeof generatedTypeName !== 'string') {
			// original type was not a name expression
			return false;
		} else if (generatedTypeName === "Object" || generatedTypeName === "undefined") {
			return true;
		} else if (generatedTypeName.substring(0, typeUtils.GEN_NAME.length) !== typeUtils.GEN_NAME) {
			// not a synthetic type, so not empty
			return false;
		}


		// now check to see if there are any non-default fields in this type
		var type = allTypes[generatedTypeName];
		var popCount = 0;
		// type should have a $$proto only and nothing else if it is empty
		for (var property in type) {
			if (type.hasOwnProperty(property)) {
				popCount++;
				if (popCount > 1) {
					break;
				}
			}
		}
		if (popCount === 1) {
			// we have an empty object literal, must check parent
			// must traverse prototype hierarchy to make sure empty
			return isEmpty(type.$$proto.typeObj.name, allTypes);
		}
		return false;
	}


	/**
	 * Determines if the left type name is more general than the right type name.
	 * Generality (>) is defined as follows:
	 * undefined > Object > Generated empty type > all other types
	 *
	 * A generated empty type is a generated type that has only a $$proto property
	 * added to it.  Additionally, the type specified in the $$proto property is
	 * either empty or is Object
	 *
	 * @param {{}} leftTypeObj
	 * @param {{}} rightTypeObj
	 * @param {{getAllTypes:function():Object}} env
	 *
	 * @return Boolean
	 */
	function leftTypeIsMoreGeneral(leftTypeObj, rightTypeObj, env) {
		var leftTypeName = leftTypeObj.name, rightTypeName = rightTypeObj.name;

		if (!leftTypeName) {
			if (leftTypeObj.type === 'NullLiteral' || leftTypeObj.type === 'UndefinedLiteral' || leftTypeObj.type === 'VoidLiteral') {
				leftTypeName = 'undefined';
			}
		}

		function convertToNumber(typeName) {
			if (typeName === "undefined") {
				return 0;
			} else if (typeName === "Object") {
				return 1;
			} else if (isEmpty(typeName, env.getAllTypes())) {
				return 2;
			} else {
				return 3;
			}
		}

		if (!rightTypeName) {
			return false;
		}

		var leftNum = convertToNumber(leftTypeName);
		// avoid calculating the rightNum if possible
		if (leftNum === 0) {
			return rightTypeName !== "undefined";
		} else if (leftNum === 1) {
			return rightTypeName !== "undefined" && rightTypeName !== "Object";
		} else if (leftNum === 2) {
			return rightTypeName !== "undefined" && rightTypeName !== "Object" && !isEmpty(rightTypeName, env.getAllTypes());
		} else {
			return false;
		}
	}

	/**
	 * @return boolean true iff the type contains
	 * prop.  prop must not be coming from Object
	 */
	function typeContainsProperty(type, prop) {
		if (! (prop in type)) {
			return false;
		}
		if (Object.hasOwnProperty(prop)) {
			// the propery may be re-defined in the current type
			// check that here
			return !type.hasOwnProperty(prop);
		}
		if (Object.prototype.hasOwnProperty(prop)) {
			// this is one of the synthetic properties like __defineGetter__
			// should be ignored, unless already exists in property
			return type.hasOwnProperty(prop);
		}
		return true;
	}

	/**
	 * Initializes data structures representing the known types
	 * for the file.  These known types can include DOM types for 
	 * browser-based code or node.js types.
	 *
	 * Returns a promise that is resolved with the populated 
	 * mTypes.Types object.
	 */ 
	function initKnownTypes(globalObjName) {
		var types = new mTypes.Types();
		var result;
		if (globalObjName === "Window") {
			// browser code; load the browser module
			result = mTypes.addLibrary(types,"browser");
			
		} else if (globalObjName === "Module") {
			// node.js code
			result = mTypes.addLibrary(types,"node");
		} else {
			var d = new Deferred();
			d.resolve(types);
			result = d.promise;
		}
		return result;
	}
	
	/**
	 * Creates the environment object that stores type information
	 * Called differently depending on what job this content assistant is being called to do.
	 *
	 * Returns a promise that is resolved with the environment object.
	 * TODO move to own module?
	 */
	function createEnvironment(options) {
		var buffer = options.buffer, uid = options.uid, offset = options.offset, indexer = options.indexer, globalObjName = options.globalObjName;
		if (!offset) {
			offset = buffer.length+1;
		}

		// must copy comments because the array is mutable
		var comments = [];
		if (options.comments) {
			for (var i = 0; i < options.comments.length; i++) {
				comments[i] = options.comments[i];
			}
		}


		// create a hash of the path using a hashcode calculation similar to java's String.hashCode() method
		var hashCode = function(str) {
			var hash = 0, c, i;
			if (str.length === 0) {
				return hash;
			}
			for (i = 0; i < str.length; i++) {
				c = str.charCodeAt(i);
				hash = ((hash << 5) - hash) + c;
				hash = hash & hash; // Convert to 32bit integer
			}
			return hash;
		};

		// prefix for generating local types
		// need to add a unique id for each file so that types defined in dependencies don't clash with types
		// defined locally
		var namePrefix = typeUtils.GEN_NAME + hashCode(uid) + "~";
		// uncomment to show names
//		var namePrefix = typeUtils.GEN_NAME + (uid) + "~";

		var promise = initKnownTypes(globalObjName);
		var result = promise.then(function (knownTypes) {
			return {
				/** Each element is the type of the current scope, which is a key into the types array */
				_scopeStack : ["Global"],
				/**
				 * a map of all the types and their properties currently known
				 * when an indexer exists, local storage will be checked for extra type information
				 */
				_allTypes : knownTypes,
				/** a counter used for creating unique names for object literals and scopes */
				_typeCount : 0,

				_nameStack : [],

				/** if this is an AMD module, then the value of this property is the 'define' call expression */
				amdModule : null,
				/** if this is a wrapped commonjs module, then the value of this property is the 'define' call expression */
				commonjsModule : null,
				/** the indexer for thie content assist invocation.  Used to track down dependencies */
				indexer: indexer,
				/** the offset of content assist invocation */
				offset : offset,
				/** the entire contents being completed on */
				contents : buffer,
				uid : uid === 'local' ? null : uid, // make the uid shorter
	
				/** List of comments in the AST*/
				comments : comments,
	
				newName: function() {
					return namePrefix + this._typeCount++;
				},
	
				/**
				 * @return {boolean} true iff this is an internally generated name
				 */
				isSyntheticName: function(name) {
					return name.substr(0, typeUtils.GEN_NAME.length) === typeUtils.GEN_NAME;
				},
	
				/**
				 * Creates a new empty scope and returns the name of the scope
				 * must call this.popScope() when finished with this scope
				 */
				newScope: function(range) {
					// the prototype is always the currently top level scope
					var targetType = this.scope();
					var newScopeName = this.newName();
					this._allTypes[newScopeName] = {
						$$proto : new typeUtils.Definition(targetType, range, this.uid)
					};
					this._scopeStack.push(newScopeName);
					return newScopeName;
				},
	
				newScopeObj : function(range) {
					return typeUtils.createNameType(this.newScope(range));
				},
	
				pushScope : function(scopeName) {
					this._scopeStack.push(scopeName);
				},
	
				pushName : function(name) {
					this._nameStack.push(name);
				},
	
				popName : function() {
					this._nameStack.pop();
				},
	
				getQualifiedName : function() {
					var name = this._nameStack.join('.');
					return name.length > 0 ? name + '.' : name;
				},
	
				/**
				 * Creates a new empty object scope and returns the name of this object
				 * must call this.popScope() when finished
				 * @return {{type:String,name:String}} type object that was just created
				 */
				newObject : function(newObjectName, range) {
					// object needs its own scope
					this.newScope();
					// if no name passed in, create a new one
					newObjectName = newObjectName? newObjectName : this.newName();
					// assume that objects have their own "this" object
					// prototype of Object
					this._allTypes[newObjectName] = {
						$$proto : new typeUtils.Definition("Object", range, this.uid)
					};
					var typeObj = typeUtils.createNameType(newObjectName);
					this.addVariable("this", null, typeObj, range);
	
					return typeObj;
				},
	
				/**
				 * like a call to this.newObject(), but the
				 * object created has not scope added to the scope stack
				 */
				newFleetingObject : function(name, range) {
					var newObjectName = name ? name : this.newName();
					this._allTypes[newObjectName] = {
						$$proto : new typeUtils.Definition("Object", range, this.uid)
					};
					return typeUtils.createNameType(newObjectName);
				},
	
				/**
				 * like a call to this.newObject(), but the
				 * object created has not scope added to the scope stack
				 * @return String the constructor name generated
				 */
				con: function(name, range) {
					var newObjectName = name ? name : this.newName();
					this._allTypes[newObjectName] = {
						$$proto : new typeUtils.Definition("Object", range, this.uid)
					};
					return newObjectName;
				},
	
				/** removes the current scope */
				popScope: function() {
					// Can't delete old scope since it may have been assigned somewhere
					var oldScope = this._scopeStack.pop();
					return oldScope;
				},
	
				/**
				 * @param {ASTNode|String} target
				 * @return {{}} the type object for the current scope
				 * if a target is passed in (optional), then use the
				 * inferred type of the target instead (if it exists)
				 */
				scope : function(target) {
					if (typeof target === "string") {
						return target;
					} else if (target && target.extras.inferredTypeObj) {
						var inferredTypeObj = target.extras.inferredTypeObj;
						// TODO what happens if not a NameExpression or FunctionType???
						if (inferredTypeObj.type === 'NameExpression') {
							return inferredTypeObj.name;
						} else if (inferredTypeObj.type === 'FunctionType') {
							if (inferredTypeObj.params) {
								for (var i = 0; i < inferredTypeObj.params.length; i++) {
									if ((inferredTypeObj.params[i].name === 'new' ||
										inferredTypeObj.params[i].name === 'this') &&
										inferredTypeObj.params[i].expression.name) {
	
										return inferredTypeObj.params[i].expression.name;
									}
								}
							}
							return "Function";
						} else if (inferredTypeObj.type === 'ArrayType') {
							return "Array";
						}
					} else {
						// grab topmost scope
						return this._scopeStack[this._scopeStack.length -1];
					}
				},
	
				globalScope : function() {
					return this._allTypes[this._scopeStack[0]];
				},
	
				globalTypeName : function() {
					return this._scopeStack[0];
				},
	
				/**
				 * adds the name to the target type.
				 * if target is passed in then use the type corresponding to
				 * the target, otherwise use the current scope
				 *
				 * Will not override an existing variable if the new typeName is "Object" or "undefined"
				 * Will not add to a built in type
				 *
				 * @param {String} name
				 * @param {{}} typeObj
				 * @param {Object} target
				 * @param {Array.<Number>} range
				 * @param {Array.<Number>} docRange
				 */
				addVariable : function(name, target, typeObj, range, docRange) {
					if (name === 'prototype') {
						name = '$$prototype';
					} else if (name === '__proto__') {
						name = '$$proto';
					} else if (this._allTypes.Object["$_$" + name]) {
						// this is a built in property of object.  do not redefine
						return;
					}
					var type = this._allTypes[this.scope(target)];
					// do not allow augmenting built in types
					if (!type.$$isBuiltin) {
						// if new type name is not more general than old type, do not replace
						if (typeContainsProperty(type, name) && leftTypeIsMoreGeneral(typeObj, type[name].typeObj, this)) {
							// do nuthin
						} else {
							type[name] = new typeUtils.Definition(typeObj ? typeObj : typeUtils.OBJECT_TYPE, range, this.uid);
							type[name].docRange = docRange;
							return type[name];
						}
					}
				},
	
				addOrSetGlobalVariable : function(name, typeObj, range, docRange) {
					if (this._allTypes.Object["$_$" + name]) {
						// this is a built in property of object.  do not redefine
						return;
					}
					return this.addOrSetVariable(name,
						// mock an ast node with a global type
						this.globalTypeName(), typeObj, range, docRange);
				},
	
				/**
				 * like add variable, but first checks the prototype hierarchy
				 * if exists in prototype hierarchy, then replace the type
				 *
				 * Will not override an existing variable if the new typeName is "Object" or "undefined"
				 */
				addOrSetVariable : function(name, target, typeObj, range, docRange) {
					if (name === 'prototype') {
						name = '$$prototype';
					} else if (name === '__proto__') {
						name = '$$proto';
					} else if (this._allTypes.Object["$_$" + name]) {
						// this is a built in property of object.  do not redefine
						return;
					}
	
					var targetTypeName = this.scope(target);
					var current = this._allTypes[targetTypeName], found = false;
					// if no type provided, create a new type
					typeObj = typeObj ? typeObj : this.newFleetingObject();
					var defn;
					while (current) {
						if (typeContainsProperty(current, name)) {
							defn = current[name];
							// found it, just overwrite
							// do not allow overwriting of built in types
							// 3 cases to avoid:
							//  1. properties of builtin types cannot be set
							//  2. builtin types cannot be redefined
							//  3. new type name is more general than old type
							if (!current.$$isBuiltin && current.hasOwnProperty(name) &&
									!leftTypeIsMoreGeneral(typeObj, defn.typeObj, this)) {
								// since we are just overwriting the type we do not want to change
								// the path or the range
								defn.typeObj = typeObj;
								if (docRange) {
									defn.docRange = docRange;
								}
								// special case: if we're updating $$prototype, and $$newtype is
								// also present, update $$proto of newType appropriately
								if (name === '$$prototype' && current.$$newtype) {
								  var newType = this._allTypes[current.$$newtype.typeObj.name];
								  newType.$$proto.typeObj = typeObj;
								}
	
							}
							found = true;
							break;
						} else if (current.$$proto) {
							var tname = current.$$proto.typeObj.name;
							current = this._allTypes[tname || "Function"];
						} else {
							current = null;
						}
					}
	
					if (!found) {
						// not found, so just add to current scope
						// do not allow overwriting of built in types
						var type = this._allTypes[targetTypeName];
						if (!type.$$isBuiltin) {
							defn = new typeUtils.Definition(typeObj, range, this.uid);
							defn.docRange = docRange;
							type[name] = defn;
						}
					}
					return defn;
				},
	
				/**
				 * looks up the name in the hierarchy
				 * @return {{}} type objec for the current name or null if doesn't exist
				 */
				lookupTypeObj : function(name, target, includeDefinition) {
	
					// translate function names on object into safe names
					var swapper = function(name) {
						switch (name) {
							case "prototype":
								return "$$prototype";
							case "__proto__":
								return "$$proto";
							case "toString":
							case "hasOwnProperty":
							case "toLocaleString":
							case "valueOf":
							case "isProtoTypeOf":
							case "propertyIsEnumerable":
								return "$_$" + name;
							default:
								return name;
						}
					};
	
					var innerLookup = function(name, type, allTypes) {
						var res = type[name];
	
						var proto = type.$$proto;
						if (res) {
							return includeDefinition || name === '$$fntype' ? res : res.typeObj;
						} else if (proto) {
							return innerLookup(name, allTypes[proto.typeObj.name], allTypes);
						} else {
							return null;
						}
					};
					var targetType = this._allTypes[this.scope(target)];
	
					// uncomment this if we want to hide errors where there is an unknown type being placed on the scope stack
	//				if (!targetType) {
	//					targetType = this.globalScope()
	//				}
					var res = innerLookup(swapper(name), targetType, this._allTypes);
					return res;
				},
	
				/** removes the variable from the current type */
				removeVariable : function(name, target) {
					// do not allow deleting properties of built in types
					var type = this._allTypes[this.scope(target)];
					// 2 cases to avoid:
					//  1. properties of builtin types cannot be deleted
					//  2. builtin types cannot be deleted from global scope
					if (!type.$$isBuiltin && type[name] && !(type[name] && !type.hasOwnProperty(name))) {
						delete type[name];
					}
				},
	
				/**
				 * adds a file summary to this module
				 * @param {{types, provided}} summary
				 * @param String targetTypeName
				 */
				mergeSummary : function(summary, targetTypeName) {
					var defn, existingDefn, property;
					// add the extra types that don't already exists
					for (var typeName in summary.types) {
						if (summary.types.hasOwnProperty(typeName)) {
							// create type if doesn't already exist, othewise merge
							var type = this._allTypes[typeName];
							var existingType = summary.types[typeName];
							// if doesn't exist yet create it
							// if type is built-in, then we must overwrite it with ours
							if (!type || type.$$isBuiltin) {
								type = this._allTypes[typeName] = {};
								// for each property defined in the type from the sumamry,
								// also add it to the current module's type
								for (var typeProp in existingType) {
									if (!type[typeProp]) {
										type[typeProp] = typeUtils.Definition.revive(existingType[typeProp]);
									}
								}
							}
	
						}
					}
	
					// now augment the target type with the provided properties
					// but only if a composite type is exported
					var targetType = this._allTypes[targetTypeName];
					if (typeof summary.provided !== 'string') {
						// TODO summary.provided mightbe a RecordType
						for (var providedProperty in summary.provided) {
							if (summary.provided.hasOwnProperty(providedProperty)) {
								// copy over the summary into the type den
								// the targetType may already have the providedProperty defined
								// but should override
								targetType[providedProperty] = typeUtils.Definition.revive(summary.provided[providedProperty]);
							}
						}
					}
				},
	
				/**
				 * creates a new type for a function, and returns the type name.
				 */
				initFunctionType : function(functionTypeObj,node,newObjectType,newTypeName) {
					var newObjectName = newObjectType.name;
				    // The 'prototype' field of a function points to a new empty object
				    var emptyProtoName = this.newFleetingObject(newObjectName + "~proto");
				    // __proto__ points to Function
					this._allTypes[newObjectName].$$proto = new typeUtils.Definition("Function",null,this.uid);
					// we store the function signature in $$fntype
					this._allTypes[newObjectName].$$fntype = functionTypeObj;
					// store 'prototype' in $$prototype
					this._allTypes[newObjectName].$$prototype = new typeUtils.Definition(emptyProtoName,null,this.uid);
					// to handle writes to 'this' inside the function, we create another type thisType.  thisType
					// has the empty object as its $$proto.  And thisType is the type ascribed to a new invocation.
					// in this manner, writes to fields of this override types in the empty prototype.
					if (!newTypeName) {
					  newTypeName = newObjectName + "~new";
					}
					this.newObject(newTypeName, node.range);
					this._allTypes[newObjectName].$$newtype = new typeUtils.Definition(newTypeName,null,this.uid);
					this._allTypes[newTypeName].$$proto = new typeUtils.Definition(emptyProtoName,null,this.uid);
				},
	
	            /**
	             * update the $$newtype of a function expression created in an object literal to have the final
	             * types for all the object literal's properties
	             */
	            updateObjLitFunctionType: function(objLitNode,propName,funcExpNode) {
	              var objLitTypeName = objLitNode.extras.inferredTypeObj.name, funcTypeName = funcExpNode.extras.inferredTypeObj.name;
	              if (objLitTypeName && funcTypeName) {
	                var objLitType = this._allTypes[objLitTypeName];
	                var funcExpNewType = this._allTypes[this._allTypes[funcTypeName].$$newtype.typeObj.name];
	                for (var p in objLitType) {
	                  // NOTE we don't add a property if it already exists, to preserve writes to 'this'
	                  // inside the function.  Also, don't add a type for the corresponding property name
	                  if (objLitType.hasOwnProperty(p) && !funcExpNewType.hasOwnProperty(p) && p !== propName && p.indexOf("$$") !== 0) {
	                    funcExpNewType[p] = objLitType[p];
	                  }
	                }
	              }
	            },
	            /**
	             * updates a function type to include a new return type.
	             * function types are specified like this: ?returnType:[arg-n...]
	             * return type is the name of the return type, arg-n is the name of
	             * the nth argument.
	             */
	            updateReturnType : function(typeObj,newReturnTypeObj) {
					if (! typeObj) {
						return newReturnTypeObj;
					}
					var originalFunctionTypeObj = this._allTypes[typeObj.name].$$fntype;
					if (!originalFunctionTypeObj) {
						return newReturnTypeObj;
					} else {
						var newFunctionTypeObj = {
							type: originalFunctionTypeObj.type,
							params: originalFunctionTypeObj.params,
							result: newReturnTypeObj
						};
						if (originalFunctionTypeObj['this']) {
							newFunctionTypeObj['this'] = originalFunctionTypeObj['this'];
						}
						if (originalFunctionTypeObj['new']) {
							newFunctionTypeObj['new'] = originalFunctionTypeObj['new'];
						}
						this._allTypes[typeObj.name].$$fntype = newFunctionTypeObj;
						return newFunctionTypeObj;
					}
				},
	
	            /**
	             * get the result type for invoking target via a 'new' expression.
	             */
	            getNewType : function(target) {
	              var result = this.lookupTypeObj("$$newtype",target);
	              if (!result) {
	                // TODO MS get rid of this code once we fix types.js
	                var inferredTypeObj = target.extras.inferredTypeObj;
	                result = typeUtils.extractReturnType(inferredTypeObj);
	              }
	              return result;
	            },
	
	            /**
	             * get the result type for invoking target via a 'new' expression.
	             */
	            getFnType : function(target) {
	              var result = this.lookupTypeObj("$$fntype",target);
	              if (!result) {
	                // TODO MS get rid of this code once we fix types.js
	                result = target.extras.inferredTypeObj;
	              }
	              return result;
	            },
	
	
				/** @returns {{}} entry in types array */
				findType : function(typeObj) {
					var typeName = typeUtils.convertToSimpleTypeName(typeObj);
					return this._allTypes[typeName];
				},
	
				getAllTypes : function() {
					return this._allTypes;
				},
	
				/**
				 * This function stores the target type
				 * so it can be used as the result of this inferencing operation
				 */
				storeTarget : function(targetTypeName) {
					if (!this.targetTypeName) {
						if (!targetTypeName) {
							targetTypeName = this.scope();
						}
						this.targetTypeName = targetTypeName;
						this.targetFound = true;
					}
				}
			};
		});
		return result;
	}

	function createProposalDescription(propName, propType, env) {
		return propName + " : " + typeUtils.createReadableType(propType, env);
	}

	function createInferredProposals(targetTypeName, env, completionKind, prefix, replaceStart, proposals, relevance) {
		var prop, propTypeObj, propName, res, type = env.getAllTypes()[targetTypeName], proto = type.$$proto;
		if (!relevance) {
			relevance = 100;
		}
		// start at the top of the prototype hierarchy so that duplicates can be removed
		if (proto) {
			createInferredProposals(proto.typeObj.name, env, completionKind, prefix, replaceStart, proposals, relevance - 10);
		}

		// add a separator proposal
		proposals['---dummy' + relevance] = {
			proposal: '',
			description: '---------------------------------',
			relevance: relevance -1,
			style: 'hr',
			unselectable: true
		};

		// need to look at prototype for global and window objects
		// so need to traverse one level up prototype hierarchy if
		// the next level is not Object
		var realProto = Object.getPrototypeOf(type);
		var protoIsObject = !Object.getPrototypeOf(realProto);
		for (prop in type) {
			if (type.hasOwnProperty(prop) || (!protoIsObject && realProto.hasOwnProperty(prop))) {
				if (prop.charAt(0) === "$" && prop.charAt(1) === "$") {
					// special property
					continue;
				}
				if (!proto && prop.indexOf("$_$") === 0) {
					// no prototype that means we must decode the property name
					propName = prop.substring(3);
				} else {
					propName = prop;
				}
				if (propName === "this" && completionKind === "member") {
					// don't show "this" proposals for non-top-level locations
					// (eg- this.this is wrong)
					continue;
				}
				if (!type[prop].typeObj) {
					// minified files sometimes have invalid property names (eg- numbers).  Ignore them)
					continue;
				}
				if (proposalUtils.looselyMatches(prefix, propName)) {
					propTypeObj = type[prop].typeObj;
					if ((env._allTypes[propTypeObj.name]) && (env._allTypes[propTypeObj.name].$$fntype)) {
						propTypeObj = env._allTypes[propTypeObj.name].$$fntype;
					}
					if (propTypeObj.type === 'FunctionType') {
						res = calculateFunctionProposal(propName,
								propTypeObj, replaceStart - 1);
						var funcDesc = res.completion + " : " + typeUtils.createReadableType(propTypeObj, env);
						proposals["$"+propName] = {
							proposal: res.completion,
							description: funcDesc,
							positions: res.positions,
							escapePosition: replaceStart + res.completion.length,
							// prioritize methods over fields
							relevance: relevance + 5,
							style: 'emphasis',
							overwrite: true
						};
					} else {
						proposals["$"+propName] = {
							proposal: propName,
							relevance: relevance,
							description: createProposalDescription(propName, propTypeObj, env),
							style: 'emphasis',
							overwrite: true
						};
					}
				}
			}
		}
	}

	function createNoninferredProposals(environment, prefix, replaceStart, proposals) {
		var proposalAdded = false;
		// a property to return is one that is
		//  1. defined on the type object
		//  2. prefixed by the prefix
		//  3. doesn't already exist
		//  4. is not an internal property
		function isInterestingProperty(type, prop) {
			return type.hasOwnProperty(prop) && prop.indexOf(prefix) === 0 && !proposals['$' + prop] && prop !== '$$proto'&& prop !== '$$isBuiltin' &&
			prop !== '$$fntype' && prop !== '$$newtype' && prop !== '$$prototype';
		}
		function forType(type) {
			for (var prop in type) {
				if (isInterestingProperty(type, prop)) {
					var propType = type[prop].typeObj;
					if (propType.type === 'FunctionType') {
						var res = calculateFunctionProposal(prop, propType, replaceStart - 1);
						proposals[prop] = {
							proposal: removePrefix(prefix, res.completion),
							description: createProposalDescription(prop, propType, environment),
							positions: res.positions,
							escapePosition: replaceStart + res.completion.length,
							// prioritize methods over fields
							relevance: -99,
							style: 'noemphasis'
						};
						proposalAdded = true;
					} else {
						proposals[prop] = {
							proposal: removePrefix(prefix, prop),
							description: createProposalDescription(prop, propType, environment),
							relevance: -100,
							style: 'noemphasis'
						};
						proposalAdded = true;
					}
				}
			}
		}
		var allTypes = environment.getAllTypes();
		for (var typeName in allTypes) {
			// need to traverse into the prototype
			if (allTypes[typeName].$$proto) {
				forType(allTypes[typeName]);
			}
		}

		if (proposalAdded) {
			proposals['---dummy'] = {
				proposal: '',
				description: 'Non-inferred proposals',
				relevance: -98,
				style: 'noemphasis',
				unselectable: true
			};
		}
	}

	function visitTypeStructure(typeObj, operation) {
		if (typeof typeObj !== 'object') {
			return;
		}
		switch (typeObj.type) {
			case 'NullableLiteral':
			case 'AllLiteral':
			case 'NullLiteral':
			case 'UndefinedLiteral':
			case 'VoidLiteral':
				// leaf nodes
				return;

			case 'NameExpression':
				operation(typeObj, operation);
				return;

			case 'ArrayType':
				visitTypeStructure(typeObj.expression, operation);
				// fall-through
			case 'UnionType':
				if (typeObj.elements) {
					typeObj.elements.forEach(function(elt) { visitTypeStructure(elt, operation); });
				}
				return;

			case 'RecordType':
				if (typeObj.fields) {
					typeObj.fields.forEach(function(elt) { visitTypeStructure(elt, operation); });
				}
				return;

			case 'FieldType':
				visitTypeStructure(typeObj.expression, operation);
				return;

			case 'FunctionType':
				// do we need to check for serialized functions???
				if (typeObj.params) {
					typeObj.params.forEach(function(elt) { visitTypeStructure(elt, operation); });
				}
				if (typeObj.result) {
					visitTypeStructure(typeObj.result, operation);
				}
				return;

			case 'ParameterType':
				// TODO FIXADE uncomment to make the size of summaries smaller
				// by not including parameter types in summary.
//				typeObj.expression = { name: 'Object', type: 'NameExpression' };
				visitTypeStructure(typeObj.expression, operation);
				return;

			case 'TypeApplication':
				if (typeObj.applications) {
					typeObj.applications.forEach(function(elt) { visitTypeStructure(elt, operation); });
				}

				// fall-throudh
			case 'RestType':
			case 'NonNullableType':
			case 'OptionalType':
			case 'NullableType':
				visitTypeStructure(typeObj.expression, operation);
				return;


		}
	}

	// finds unreachable types from the given type name
	// and marks them as already seen
	function findUnreachable(currentTypeName, allTypes, alreadySeen) {
		var currentType = allTypes[currentTypeName];
		var operation = function(typeObj, operation) {
			if (alreadySeen[typeObj.name]) {
				// prevent infinite recursion for circular refs
				return;
			}

			alreadySeen[typeObj.name] = true;
			findUnreachable(typeObj.name, allTypes, alreadySeen);
		};

		if (currentType) {
			for(var prop in currentType) {
				if (currentType.hasOwnProperty(prop) && prop !== '$$isBuiltin' ) {
					var propType = prop === '$$fntype' ? currentType[prop] : currentType[prop].typeObj;
					// don't count $$newtype as keeping a type reachable, since we inline function types
					if (prop === '$$newtype') { continue; }
					// must visit the type strucutre
					visitTypeStructure(propType, operation);
				}
			}
		}
	}

	/**
	 * Before we can remove empty objects from the type graph, we need to update
	 * the properties currently pointing to those types.  Make them point to the
	 * closest non-empty type in their prototype hierarchy (most likely, this is Object).
	 */
	function fixMissingPointers(currentTypeObj, allTypes, empties, alreadySeen) {
		alreadySeen = alreadySeen || {};
		var operation = function(typeObj, operation) {
			while (empties[typeObj.name]) {
				// change this to the first non-epty prototype of the empty type
				typeObj.name = allTypes[typeObj.name].$$proto.typeObj.name;
				if (!typeObj.name) {
					typeObj.name = 'Object';
				}
			}
			if (alreadySeen[typeObj.name]) {
				return;
			}
			alreadySeen[typeObj.name] = true;
			var currentType = allTypes[typeObj.name];
			if (currentType) {
				for(var prop in currentType) {
					if (currentType.hasOwnProperty(prop) && prop !== '$$isBuiltin' ) {
						var propType = prop === '$$fntype' ? currentType[prop] : currentType[prop].typeObj;
						// must visit the type strucutre
						visitTypeStructure(propType, operation);
					}
				}
			}
		};

		visitTypeStructure(currentTypeObj, operation);
	}

	/**
	 * Is typeObj a reference to a function type?
	 */
	function fnTypeRef(typeObj, allTypes) {
		return typeObj.type === "NameExpression" &&
			allTypes[typeObj.name] && allTypes[typeObj.name].$$fntype;
	}

	/**
	 * Inline all the function types referenced from the function type
	 * def, by replacing references to object types with a $$fntype
	 * property to the value of the $$fntype property
	 */
	function inlineFunctionTypes(def,allTypes,fnTypes) {
		if (def.params) {
			for (var i = 0; i < def.params.length; i++) {
				var paramType = def.params[i];
				if (fnTypeRef(paramType, allTypes)) {
					if (fnTypes) { fnTypes[paramType.name] = true; }
					inlineFunctionTypes(allTypes[paramType.name].$$fntype,allTypes,fnTypes);
					def.params[i] = allTypes[paramType.name].$$fntype;
				}
			}
		}
		if (def.result) {
			if (fnTypeRef(def.result, allTypes)) {
				if (fnTypes) { fnTypes[def.result.name] = true; }
				inlineFunctionTypes(allTypes[def.result.name].$$fntype,allTypes,fnTypes);
				def.result = allTypes[def.result.name].$$fntype;
			}
		}
	}

	/**
	 * filters types from the environment that should not be exported
	 */
	function filterTypes(environment, kind, moduleTypeObj, provided) {
		var moduleTypeName = doctrine.type.stringify(moduleTypeObj, {compact: true});
		var allTypes = environment.getAllTypes();
		allTypes.clearDefaultGlobal();


		// recursively walk the type tree to find unreachable types and delete them, too
		var reachable = { };
		var wasReachable = true;
		if (moduleTypeObj.type !== "NameExpression") {
			// TODO FIXADE duplicated code
			visitTypeStructure(moduleTypeObj, function(typeObj, operation) {
				if (reachable[typeObj.name]) {
					// prevent infinite recursion for circular refs
					return;
				}
				reachable[typeObj.name] = true;
				findUnreachable(typeObj.name, allTypes, reachable);
			});
		} else {
			// first remove any types that are unreachable
			findUnreachable(moduleTypeName, allTypes, reachable);
			if (!reachable[moduleTypeName]) {
				// not really reachable, but need to keep it for now to track empties
				reachable[moduleTypeName] = true;
				wasReachable = false;
			}
		}
		for (var prop in allTypes) {
			if (allTypes.hasOwnProperty(prop) && !reachable[prop]) {
				delete allTypes[prop];
			}
		}

		// now find empty types
		var empties = {};
		Object.keys(allTypes).forEach(function(key) {
			if (isEmpty(key, allTypes)) {
				empties[key] = true;
			}
		});
		// now fix up pointers to empties
		fixMissingPointers(moduleTypeObj, allTypes, empties);

		if (!wasReachable) {
			delete allTypes[moduleTypeName];
		}
		// don't need the empty types any more
		Object.keys(empties).forEach(function(key) {
			delete allTypes[key];
		});

		// for now, we delete *all* object types representing functions,
		// "inlining" the function type wherever it appears
		// TODO devise a serialized representation for function types with
		// properties
		var fnTypes = {};

		// now reformat the types so that they are combined and serialized
		Object.keys(allTypes).forEach(function(typeName) {
		    var type = allTypes[typeName];
			for (var defName in type) {
				if (type.hasOwnProperty(defName)) {
					var def = type[defName];
					if (defName === '$$fntype') {
						// here, we still need to "inline" function types for parameters
						// and result
						// TODO make this a visitor?
						inlineFunctionTypes(def, allTypes, fnTypes);
					} else {
						var typeObj = def.typeObj;
						if (fnTypeRef(typeObj, allTypes)) {
							fnTypes[typeObj.name] = true;
							typeObj = allTypes[typeObj.name].$$fntype;
						}
						def.typeSig = doctrine.type.stringify(typeObj, {compact: true});
						delete def._typeObj;
					}
				}
			}
		});

		if (typeof provided === 'object') {
			for (var defName in provided) {
				if (provided.hasOwnProperty(defName)) {
					var def = provided[defName];
					if (defName === '$$fntype') {
						inlineFunctionTypes(def, allTypes, fnTypes);
					} else {
						if (def.typeObj) {
							var typeObj = def.typeObj;
							if (fnTypeRef(typeObj, allTypes)) {
								fnTypes[typeObj.name] = true;
								typeObj = allTypes[typeObj.name].$$fntype;
							}
							def.typeSig = doctrine.type.stringify(typeObj, {compact: true});
							delete def._typeObj;
						}
					}
				}
			}
		}

		// finally, delete all function types
		Object.keys(fnTypes).forEach(function(key) {
			delete allTypes[key];
		});

	}

	var browserRegExp = /browser\s*:\s*true/;
	var nodeRegExp = /node\s*:\s*true/;
	function findGlobalObject(comments, lintOptions) {

		for (var i = 0; i < comments.length; i++) {
			var comment = comments[i];
			if (comment.type === "Block" && (comment.value.substring(0, "jslint".length) === "jslint" ||
											  comment.value.substring(0,"jshint".length) === "jshint")) {
				// the lint options section.  now look for the browser or node
				if (comment.value.match(browserRegExp)) {
					return "Window";
				} else if (comment.value.match(nodeRegExp)) {
					return "Module";
				} else {
					return "Global";
				}
			}
		}
		if (lintOptions && lintOptions.options) {
			if (lintOptions.options.browser === true) {
				return "Window";
			} else if (lintOptions.options.node === true) {
				return "Module";
			}
		}
		return "Global";
	}

	function filterAndSortProposals(proposalsObj) {
		// convert from object to array
		var proposals = [];
		for (var prop in proposalsObj) {
			if (proposalsObj.hasOwnProperty(prop)) {
				proposals.push(proposalsObj[prop]);
			}
		}
		proposals.sort(function(l,r) {
			// sort by relevance and then by name
			if (l.relevance > r.relevance) {
				return -1;
			} else if (r.relevance > l.relevance) {
				return 1;
			}

			var ldesc = l.description.toLowerCase();
			var rdesc = r.description.toLowerCase();
			if (ldesc < rdesc) {
				return -1;
			} else if (rdesc < ldesc) {
				return 1;
			}
			return 0;
		});

		// filter trailing and leading dummies, as well as double dummies
		var toRemove = [];

		// now remove any leading or trailing dummy proposals as well as double dummies
		var i = proposals.length -1;
		while (i >= 0 && proposals[i].description.indexOf('---') === 0) {
			toRemove[i] = true;
			i--;
		}
		i = 0;
		while (i < proposals.length && proposals[i].description.indexOf('---') === 0) {
			toRemove[i] = true;
			i++;
		}
		i += 1;
		while (i < proposals.length) {
			if (proposals[i].description.indexOf('---') === 0 && proposals[i-1].description.indexOf('---') === 0) {
				toRemove[i] = true;
			}
			i++;
		}

		var newProposals = [];
		for (i = 0; i < proposals.length; i++) {
			if (!toRemove[i]) {
				newProposals.push(proposals[i]);
			}
		}

		return newProposals;
	}


	/**
	 * indexer is optional.  When there is no indexer passed in
	 * the indexes will not be consulted for extra references
	 * @param {{hasDependency,performIndex,retrieveSummary,retrieveGlobalSummaries}} indexer
	 * @param {{global:[],options:{browser:Boolean}}=} lintOptions optional set of extra lint options that can be overridden in the source (jslint or jshint)
	 */
	function EsprimaJavaScriptContentAssistProvider(indexer, lintOptions) {
		this.indexer = indexer;
		this.lintOptions = lintOptions;
	}

	/**
	 * Main entry point to provider
	 */
	EsprimaJavaScriptContentAssistProvider.prototype = {

		_doVisit : function(root, environment) {
			// first augment the global scope with things we know
			addLintGlobals(environment, this.lintOptions);
			addIndexedGlobals(environment);

			// now we can remove all non-doc comments from the comments list
			var newComments = [];
			for (var i = 0; i < environment.comments.length; i++) {
				if (environment.comments[i].value.charAt(0) === '*') {
					newComments.push(environment.comments[i]);
				}
			}
			environment.comments = newComments;

			try {
				mVisitor.visit(root, environment, inferencer, inferencerPostOp);
			} catch (done) {
				if (typeof done !== "string") {
					// a real error
					throw done;
				}
				return done;
			}
			throw new Error("The visit function should always end with a throwable");
		},

		/**
		 * implements the Orion content assist API
		 */
		computeProposals: function(buffer, offset, context) {
			function emptyArrayPromise() {
				var d = new Deferred();
				d.resolve([]);
				return d.promise;
			}
			if (context.selection && context.selection.start !== context.selection.end) {
				// only propose if an empty selection.
				return emptyArrayPromise();
			}

			try {
				var root = mVisitor.parse(buffer);
				if (!root) {
					// assume a bad parse
					return emptyArrayPromise();
				}
				// note that if selection has length > 0, then just ignore everything past the start
				var completionKind = shouldVisit(root, offset, context.prefix, buffer);
				if (completionKind) {
					var environmentPromise = createEnvironment({ buffer: buffer, uid : "local", offset : offset, indexer : this.indexer, globalObjName : findGlobalObject(root.comments, this.lintOptions), comments : root.comments });
					var self = this;
					var result = environmentPromise.then(function (environment) {
						// must defer inferring the containing function block until the end
						environment.defer = completionKind.toDefer;
						if (environment.defer) {
							// remove these comments from consideration until we are inferring the deferred
							environment.deferredComments = extractDocComments(environment.comments, environment.defer.range);
						}
						var target = self._doVisit(root, environment);
						var proposalsObj = { };
						createInferredProposals(target, environment, completionKind.kind, context.prefix, offset - context.prefix.length, proposalsObj);
						if (!context.inferredOnly) {
							// include the entire universe as potential proposals
							createNoninferredProposals(environment, context.prefix, offset - context.prefix.length, proposalsObj);
						}
						return filterAndSortProposals(proposalsObj);
					});
					return result;
				} else {
					// invalid completion location
					return emptyArrayPromise();
				}
			} catch (e) {
				if (typeof scriptedLogger !== "undefined") {
					scriptedLogger.error(e.message, "CONTENT_ASSIST");
					scriptedLogger.error(e.stack, "CONTENT_ASSIST");
				}
				throw (e);
			}
		},


		_internalFindDefinition : function(buffer, offset, findName) {
			var toLookFor;
			var root = mVisitor.parse(buffer);
			if (!root) {
				// assume a bad parse
				return null;
			}
			var funcList = [];
			var environment = createEnvironment({ buffer: buffer, uid : "local", offset : offset, indexer : this.indexer, globalObjName : findGlobalObject(root.comments, this.lintOptions), comments : root.comments });
			var findIdentifier = function(node) {
				if ((node.type === "Identifier" || node.type === "ThisExpression") && inRange(offset, node.range, true)) {
					toLookFor = node;
					// cut visit short
					throw "done";
				}
				// FIXADE esprima bug...some call expressions have incorrect slocs.
				// This is fixed in trunk of esprima.
				// after next upgrade of esprima if the following has correct slocs, then
				// can remove the second part of the &&
				// mUsers.getUser().name
				if (node.range[0] > offset &&
						(node.type === "ExpressionStatement" ||
						 node.type === "ReturnStatement" ||
						 node.type === "ifStatement" ||
						 node.type === "WhileStatement" ||
						 node.type === "Program")) {
					// not at a valid hover location
					throw "no hover";
				}

				// the last function pushed on is the one that we need to defer
				if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
					funcList.push(node);
				}
				return true;
			};

			try {
				mVisitor.visit(root, {}, findIdentifier, function(node) {
					if (node === funcList[funcList.length-1]) {
						funcList.pop();
					}
				});
			} catch (e) {
				if (e === "no hover") {
					// not at a valid hover location
					return null;
				} else if (e === "done") {
					// valid hover...continue
				} else {
					// a real exception
					throw e;
				}
			}
			if (!toLookFor) {
				// no hover target found
				return null;
			}
			// must defer inferring the containing function block until the end
			environment.defer = funcList.pop();
			if (environment.defer && toLookFor === environment.defer.id) {
				// don't defer if target is name of function
				delete environment.defer;
			}

			if (environment.defer) {
				// remove these comments from consideration until we are inferring the deferred
				environment.deferredComments = extractDocComments(environment.comments, environment.defer.range);
			}

			var target = this._doVisit(root, environment);
			var lookupName = toLookFor.type === "Identifier" ? toLookFor.name : 'this';
			var maybeType = environment.lookupTypeObj(lookupName, toLookFor.extras.target || target, true);
			if (maybeType) {
				// if it's a reference to a function type, suck out $$fntype
				var allTypes = environment.getAllTypes();
				if (fnTypeRef(maybeType.typeObj,allTypes)) {
					inlineFunctionTypes(allTypes[maybeType.typeObj.name].$$fntype,allTypes);
					maybeType.typeObj = allTypes[maybeType.typeObj.name].$$fntype;
				}
				var hover = typeUtils.styleAsProperty(lookupName, findName) + " : " + typeUtils.createReadableType(maybeType.typeObj, environment, true, 0, findName);
				maybeType.hoverText = hover;
				return maybeType;
			} else {
				return null;
			}

		},
		/**
		 * Computes the hover information for the provided offset
		 */
		computeHover: function(buffer, offset) {
			return this._internalFindDefinition(buffer, offset, true);
		},

		findDefinition : function(buffer, offset) {
			return this._internalFindDefinition(buffer, offset, false);
		},

		/**
		 * Computes a summary of the file that is suitable to be stored locally and used as a dependency
		 * in another file
		 * @param {String} buffer
		 * @param {String} fileName
		 */
		computeSummary: function(buffer, fileName) {
			var root = mVisitor.parse(buffer);
			if (!root) {
				// assume a bad parse
				return null;
			}
			var environment = createEnvironment({ buffer: buffer, uid : fileName, globalObjName : findGlobalObject(root.comments, this.lintOptions), comments : root.comments, indexer : this.indexer });
			try {
				this._doVisit(root, environment);
			} catch (e) {
				if (typeof scriptedLogger !== "undefined") {
					scriptedLogger.error("Problem inferring in: " + fileName, "CONTENT_ASSIST");
					scriptedLogger.error(e.message, "CONTENT_ASSIST");
					scriptedLogger.error(e.stack, "CONTENT_ASSIST");
				}
				throw (e);
			}
			var providedType;
			var kind;
			var modTypeObj;
			if (environment.amdModule) {
				// provide the exports of the AMD module
				// the exports is the return value of the final argument
				var args = environment.amdModule["arguments"];
				if (args && args.length > 0) {
					modTypeObj = typeUtils.extractReturnType(environment.getFnType(args[args.length-1]));
				} else {
					modTypeObj = typeUtils.OBJECT_TYPE;
				}
				kind = "AMD";
			} else if (environment.commonjsModule) {
				// a wrapped commonjs module
				// we have already checked the correctness of this function
				var exportsParam = environment.commonjsModule["arguments"][0].params[1];
				modTypeObj = exportsParam.extras.inferredTypeObj;
				providedType = environment.findType(modTypeObj);

			} else {
				// assume a non-module
				providedType = environment.globalScope();

				// if there is an exports global or a module.exports global, then assume commonjs
				var maybeExports = providedType.exports ||
						(providedType.module && environment.getAllTypes()[providedType.module.typeObj.name] &&
						environment.getAllTypes()[providedType.module.typeObj.name].exports);

				if (maybeExports) {
					// actually, commonjs
					kind = "commonjs";
					modTypeObj = maybeExports.typeObj;
				} else {
					kind = "global";
					modTypeObj = providedType['this'].typeObj;
				}
			}

			// simplify the exported type
			if (!typeUtils.isFunctionOrConstructor(modTypeObj) &&
				!environment.findType(modTypeObj).$$isBuiltin) {

				// this module provides a composite type
				providedType = environment.findType(modTypeObj);
			}

			var allTypes = environment.getAllTypes();

			// now filter the builtins since they are always available
			filterTypes(environment, kind, modTypeObj, providedType);

			// Cases when provided type is not a record type.  store as a string
			// warning...not all cases handled here...eg- union types
			if (typeUtils.isFunctionOrConstructor(modTypeObj) ||
				(environment.findType(modTypeObj) && environment.findType(modTypeObj).$$isBuiltin)) {
				providedType = doctrine.type.stringify(modTypeObj, {compact: true});
			} else if (providedType.$$fntype) {
				providedType = doctrine.type.stringify(providedType.$$fntype, {compact: true});
			}

			return {
				provided : providedType,
				types : allTypes,
				kind : kind
			};
		}
	};
	return {
		EsprimaJavaScriptContentAssistProvider : EsprimaJavaScriptContentAssistProvider
	};
});
