/*******************************************************************************
 * @license
 * Copyright (c) 2010, 2012 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 * 
 * Contributors: IBM Corporation - initial API and implementation
 ******************************************************************************/

/*global define Node */

define("orion/editor/tooltip", [ //$NON-NLS-0$
	'i18n!orion/editor/nls/messages', //$NON-NLS-0$
	'orion/editor/textView', //$NON-NLS-0$
	'orion/editor/textModel', //$NON-NLS-0$
	'orion/editor/projectionTextModel', //$NON-NLS-0$
	'orion/util' //$NON-NLS-0$
], function(messages, mTextView, mTextModel, mProjectionTextModel, util) {

	/** @private */
	function Tooltip (view) {
		this._view = view;
		this._hideDelay = 200;
		this._create(view.getOptions("parent").ownerDocument); //$NON-NLS-0$
		view.addEventListener("Destroy", this, this.destroy); //$NON-NLS-0$
	}
	Tooltip.getTooltip = function(view) {
		if (!view._tooltip) {
			 view._tooltip = new Tooltip(view);
		}
		return view._tooltip;
	};
	Tooltip.prototype = /** @lends orion.editor.Tooltip.prototype */ {
		_create: function(document) {
			if (this._tooltipDiv) { return; }
			var tooltipDiv = this._tooltipDiv = util.createElement(document, "div"); //$NON-NLS-0$
			tooltipDiv.className = "textviewTooltip"; //$NON-NLS-0$
			tooltipDiv.setAttribute("aria-live", "assertive"); //$NON-NLS-1$ //$NON-NLS-0$
			tooltipDiv.setAttribute("aria-atomic", "true"); //$NON-NLS-1$ //$NON-NLS-0$
			var tooltipContents = this._tooltipContents = util.createElement(document, "div"); //$NON-NLS-0$
			tooltipDiv.appendChild(tooltipContents);
			document.body.appendChild(tooltipDiv);
			var self = this;
			tooltipDiv.addEventListener("mouseover", function(event) { //$NON-NLS-0$
				if (!self._hideDelay) { return; }
				var window = self._getWindow();
				if (self._delayedHideTimeout) {
					window.clearTimeout(self._delayedHideTimeout);
					self._delayedHideTimeout = null;
				}
				
				if (self._hideTimeout) {
					window.clearTimeout(self._hideTimeout);
					self._hideTimeout = null;
				}
				self._nextTarget = null;
			}, false);
			
			tooltipDiv.addEventListener("mouseout", function(event) { //$NON-NLS-0$
				var relatedCompare = event.relatedTarget.compareDocumentPosition(tooltipDiv);
				if (relatedCompare & 8) { return; }
				self._hideImpl();
			}, false);
			this._hideImpl();
		},
		_getWindow: function() {
			var document = this._tooltipDiv.ownerDocument;
			return document.defaultView || document.parentWindow;
		},
		destroy: function() {
			if (!this._tooltipDiv) { return; }
			this._hideImpl();
			var parent = this._tooltipDiv.parentNode;
			if (parent) { parent.removeChild(this._tooltipDiv); }
			this._tooltipDiv = null;
		},
		hide: function(hideDelay) {
			if (hideDelay === undefined) {
				hideDelay = this._hideDelay;
			}
			var window = this._getWindow();
			if (this._delayedHideTimeout) {
				window.clearTimeout(this._delayedHideTimeout);
				this._delayedHideTimeout = null;
			}
			var self = this;
			if (!hideDelay) {
				self._hideImpl();
				self.setTarget(self._nextTarget, 0);
			} else {
				self._delayedHideTimeout = window.setTimeout(function() {
					self._delayedHideTimeout = null;
					self._hideImpl();
					self.setTarget(self._nextTarget, 0);
				}, hideDelay);
			}
		},
		_hideImpl: function() {
			if (this._contentsView) {
				this._contentsView.destroy();
				this._contentsView = null;
			}
			if (this._tooltipContents) {
				this._tooltipContents.innerHTML = "";
			}
			if (this._tooltipDiv) {
				this._tooltipDiv.style.visibility = "hidden"; //$NON-NLS-0$
			}
			var window = this._getWindow();
			if (this._showTimeout) {
				window.clearTimeout(this._showTimeout);
				this._showTimeout = null;
			}
			if (this._delayedHideTimeout) {
				window.clearTimeout(this._delayedHideTimeout);
				this._delayedHideTimeout = null;
			}
			if (this._hideTimeout) {
				window.clearTimeout(this._hideTimeout);
				this._hideTimeout = null;
			}
			if (this._fadeTimeout) {
				window.clearInterval(this._fadeTimeout);
				this._fadeTimeout = null;
			}
		},
		isVisible: function() {
			return this._tooltipDiv && this._tooltipDiv.style.visibility === "visible"; //$NON-NLS-0$
		},
		setTarget: function(target, delay, hideDelay) {
			this._target = target;
			var visible = this.isVisible();
			if (visible) {
				this._nextTarget = target;
				this.hide(hideDelay);
			} else {
				if (target) {
					var self = this;
					var window = this._getWindow();
					if (self._showTimeout) {
						window.clearTimeout(self._showTimeout);
						self._showTimeout = null;
					}
					if (delay === 0) {
						self.show(true);
					} else {
						self._showTimeout = window.setTimeout(function() {
							self._showTimeout = null;
							self.show(true);
						}, delay ? delay : 500);
					}
				}
			}
		},
		show: function(autoHide) {
			if (!this._target) { return; }
			var info = this._target.getTooltipInfo();
			if (!info) { return; }
			var tooltipDiv = this._tooltipDiv, tooltipContents = this._tooltipContents;
			tooltipDiv.style.left = tooltipDiv.style.right = tooltipDiv.style.width = tooltipDiv.style.height = 
				tooltipContents.style.width = tooltipContents.style.height = "auto"; //$NON-NLS-0$
			var contents = info.contents;
			if (contents instanceof Array) {
				contents = this._getAnnotationContents(contents);
			}
			if (typeof contents === "string") { //$NON-NLS-0$
				tooltipContents.innerHTML = contents;
			} else if (this._isNode(contents)) {
				tooltipContents.appendChild(contents);
			} else if (contents instanceof mProjectionTextModel.ProjectionTextModel) {
				var view = this._view;
				var options = view.getOptions();
				options.wrapMode = false;
				options.parent = tooltipContents;
				var tooltipTheme = "tooltip"; //$NON-NLS-0$
				var theme = options.themeClass;
				if (theme) {
					theme = theme.replace(tooltipTheme, "");
					if (theme) { theme = " " + theme; } //$NON-NLS-0$
					theme = tooltipTheme + theme;
				} else {
					theme = tooltipTheme;
				}
				options.themeClass = theme;
				var contentsView = this._contentsView = new mTextView.TextView(options);
				//TODO this is need to avoid Firefox from getting focus
				contentsView._clientDiv.contentEditable = false;
				//TODO need to find a better way of sharing the styler for multiple views
				var listener = {
					onLineStyle: function(e) {
						view.onLineStyle(e);
					}
				};
				contentsView.addEventListener("LineStyle", listener.onLineStyle); //$NON-NLS-0$
				contentsView.setModel(contents);
				var size = contentsView.computeSize();
				tooltipContents.style.width = size.width + "px"; //$NON-NLS-0$
				tooltipContents.style.height = size.height + "px"; //$NON-NLS-0$
				contentsView.resize();
			} else {
				return;
			}
			var documentElement = tooltipDiv.ownerDocument.documentElement;
			if (info.anchor === "right") { //$NON-NLS-0$
				var right = documentElement.clientWidth - info.x;
				tooltipDiv.style.right = right + "px"; //$NON-NLS-0$
				tooltipDiv.style.maxWidth = (documentElement.clientWidth - right - 10) + "px"; //$NON-NLS-0$
			} else {
				var left = parseInt(this._getNodeStyle(tooltipDiv, "padding-left", "0"), 10); //$NON-NLS-1$ //$NON-NLS-0$
				left += parseInt(this._getNodeStyle(tooltipDiv, "border-left-width", "0"), 10); //$NON-NLS-1$ //$NON-NLS-0$
				left = info.x - left;
				tooltipDiv.style.left = left + "px"; //$NON-NLS-0$
				tooltipDiv.style.maxWidth = (documentElement.clientWidth - left - 10) + "px"; //$NON-NLS-0$
			}
			var top = parseInt(this._getNodeStyle(tooltipDiv, "padding-top", "0"), 10); //$NON-NLS-1$ //$NON-NLS-0$
			top += parseInt(this._getNodeStyle(tooltipDiv, "border-top-width", "0"), 10); //$NON-NLS-1$ //$NON-NLS-0$
			top = info.y - top;
			tooltipDiv.style.top = top + "px"; //$NON-NLS-0$
			tooltipDiv.style.maxHeight = (documentElement.clientHeight - top - 10) + "px"; //$NON-NLS-0$
			tooltipDiv.style.opacity = "1"; //$NON-NLS-0$
			tooltipDiv.style.visibility = "visible"; //$NON-NLS-0$
			if (autoHide) {
				var self = this;
				var window = this._getWindow();
				self._hideTimeout = window.setTimeout(function() {
					self._hideTimeout = null;
					var opacity = parseFloat(self._getNodeStyle(tooltipDiv, "opacity", "1")); //$NON-NLS-1$ //$NON-NLS-0$
					self._fadeTimeout = window.setInterval(function() {
						if (tooltipDiv.style.visibility === "visible" && opacity > 0) { //$NON-NLS-0$
							opacity -= 0.1;
							tooltipDiv.style.opacity = opacity;
							return;
						}
						self._hideImpl();
					}, 50);
				}, 5000);
			}
		},
		_getAnnotationContents: function(annotations) {
			if (annotations.length === 0) {
				return null;
			}
			var document = this._tooltipDiv.ownerDocument;
			var model = this._view.getModel(), annotation;
			var baseModel = model.getBaseModel ? model.getBaseModel() : model;
			function getText(start, end) {
				var textStart = baseModel.getLineStart(baseModel.getLineAtOffset(start));
				var textEnd = baseModel.getLineEnd(baseModel.getLineAtOffset(end), true);
				return baseModel.getText(textStart, textEnd);
			}
			function getAnnotationHTML(annotation) {
				var title = annotation.title;
				if (title === "") { return null; }
				var result = util.createElement(document, "div"); //$NON-NLS-0$
				if (annotation.html) {
					result.innerHTML = annotation.html + "&nbsp;"; //$NON-NLS-0$
				}
				if (!title) {
					title = getText(annotation.start, annotation.end);
				}
				if (typeof title === "function") { //$NON-NLS-0$
					title = title();
				}
				if (typeof title === "string") { //$NON-NLS-0$
					var span = util.createElement(document, "span"); //$NON-NLS-0$
					span.appendChild(document.createTextNode(title));
					title = span;
				}
				result.appendChild(title);
				return result;
			}
			if (annotations.length === 1) {
				annotation = annotations[0];
				if (annotation.title !== undefined) {
					return getAnnotationHTML(annotation);
				} else {
					var newModel = new mProjectionTextModel.ProjectionTextModel(baseModel);
					var lineStart = baseModel.getLineStart(baseModel.getLineAtOffset(annotation.start));
					var charCount = baseModel.getCharCount();
					if (annotation.end !== charCount) {
						newModel.addProjection({start: annotation.end, end: charCount});
					}
					if (lineStart > 0) {
						newModel.addProjection({start: 0, end: lineStart});
					}
					return newModel;
				}
			} else {
				var tooltipHTML = util.createElement(document, "div"); //$NON-NLS-0$
				var em = util.createElement(document, "em"); //$NON-NLS-0$
				em.appendChild(document.createTextNode(messages.multipleAnnotations));
				tooltipHTML.appendChild(em);
				for (var i = 0; i < annotations.length; i++) {
					annotation = annotations[i];
					var html = getAnnotationHTML(annotation);
					if (html) {
						tooltipHTML.appendChild(html);
					}
				}
				return tooltipHTML;
			}
		},
		_getNodeStyle: function(node, prop, defaultValue) {
			var value;
			if (node) {
				value = node.style[prop];
				if (!value) {
					if (node.currentStyle) {
						var index = 0, p = prop;
						while ((index = p.indexOf("-", index)) !== -1) { //$NON-NLS-0$
							p = p.substring(0, index) + p.substring(index + 1, index + 2).toUpperCase() + p.substring(index + 2);
						}
						value = node.currentStyle[p];
					} else {
						var css = node.ownerDocument.defaultView.getComputedStyle(node, null);
						value = css ? css.getPropertyValue(prop) : null;
					}
				}
			}
			return value || defaultValue;
		},
		_isNode: function (obj) {
			return typeof Node === "object" ? obj instanceof Node : //$NON-NLS-0$
				obj && typeof obj === "object" && typeof obj.nodeType === "number" && typeof obj.nodeName === "string"; //$NON-NLS-2$ //$NON-NLS-1$ //$NON-NLS-0$
		}
	};
	return {Tooltip: Tooltip};
});
