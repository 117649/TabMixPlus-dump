/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Load overlays in a similar way as XUL did for legacy XUL add-ons.
 */

"use strict";

this.EXPORTED_SYMBOLS = ["Overlays"];

const { ConsoleAPI } = ChromeUtils.import("resource://gre/modules/Console.jsm");
ChromeUtils.defineModuleGetter(
  this,
  "Services",
  "resource://gre/modules/Services.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "setTimeout",
  "resource://gre/modules/Timer.jsm"
);

let oconsole = new ConsoleAPI({
  prefix: "Overlays.jsm",
  consoleID: "overlays-jsm",
  maxLogLevel: "warn" // "all"
});

Components.utils.import("resource:///modules/CustomizableUI.jsm");

var Globals = {};
Globals.widgets = {};

/**
 * The overlays class, providing support for loading overlays like they used to work. This class
 * should likely be called through its static method Overlays.load()
 */
class Overlays {
  /**
   * Load overlays for the given window using the overlay provider, which can for example be a
   * ChromeManifest object.
   *
   * @param {ChromeManifest} overlayProvider        The overlay provider that contains information
   *                                                  about styles and overlays.
   * @param {DOMWindow} window                      The window to load into
   */
  static load(overlayProvider, window) {
    let instance = new Overlays(overlayProvider, window);

    let urls = overlayProvider.overlay.get(instance.location, false);
    instance.load(urls);
  }

  /**
   * Constructs the overlays instance. This class should be called via Overlays.load() instead.
   *
   * @param {ChromeManifest} overlayProvider        The overlay provider that contains information
   *                                                  about styles and overlays.
   * @param {DOMWindow} window                      The window to load into
   */
  constructor(overlayProvider, window) {
    this.overlayProvider = overlayProvider;
    this.window = window;
    if (window.location.protocol == "about:") {
      this.location = window.location.protocol + window.location.pathname;
    } else {
      this.location = window.location.origin + window.location.pathname;
    }
  }

  /**
   * A shorthand to this.window.document
   */
  get document() {
    return this.window.document;
  }

  /**
   * Loads the given urls into the window, recursively loading further overlays as provided by the
   * overlayProvider.
   *
   * @param {String[]} urls                         The urls to load
   */
  load(urls) {
    let unloadedOverlays = this._collectOverlays(this.document).concat(urls);
    let forwardReferences = [];
    this.unloadedScripts = [];
    let unloadedSheets = [];
    this._toolbarsToResolve = [];
    let xulStore = Services.xulStore;
    this.persistedIDs = new Set();

    // Load css styles from the registry
    for (let sheet of this.overlayProvider.style.get(this.location, false)) {
      unloadedSheets.push(sheet);
    }

    if (!unloadedOverlays.length && !unloadedSheets.length) {
      return;
    }

    while (unloadedOverlays.length) {
      let url = unloadedOverlays.shift();
      let xhr = this.fetchOverlay(url);
      let doc = xhr.responseXML;

      console.debug(`Applying ${url} to ${this.location}`);

      // clean the document a bit
      let emptyNodes = doc.evaluate(
        "//text()[normalize-space(.) = '']",
        doc,
        null,
        7,
        null
      );
      for (let i = 0, len = emptyNodes.snapshotLength; i < len; ++i) {
        let node = emptyNodes.snapshotItem(i);
        node.remove();
      }

      let commentNodes = doc.evaluate("//comment()", doc, null, 7, null);
      for (let i = 0, len = commentNodes.snapshotLength; i < len; ++i) {
        let node = commentNodes.snapshotItem(i);
        node.remove();
      }

      // Force a re-evaluation of inline styles to work around an issue
      // causing inline styles to be initially ignored.
      let styledNodes = doc.evaluate("//*[@style]", doc, null, 7, null);
      for (let i = 0, len = styledNodes.snapshotLength; i < len; ++i) {
        let node = styledNodes.snapshotItem(i);
        node.style.display = node.style.display; // eslint-disable-line no-self-assign
      }

      // Load css styles from the registry
      for (let sheet of this.overlayProvider.style.get(url, false)) {
        unloadedSheets.push(sheet);
      }

      // Load css processing instructions from the overlay
      let stylesheets = doc.evaluate(
        "/processing-instruction('xml-stylesheet')",
        doc,
        null,
        7,
        null
      );
      for (let i = 0, len = stylesheets.snapshotLength; i < len; ++i) {
        let node = stylesheets.snapshotItem(i);
        let match = node.nodeValue.match(/href=["']([^"']*)["']/);
        if (match) {
          unloadedSheets.push(new URL(match[1], node.baseURI).href);
        }
      }

      // Prepare loading further nested xul overlays from the overlay
      unloadedOverlays.push(...this._collectOverlays(doc));

      // Prepare loading further nested xul overlays from the registry
      for (let overlayUrl of this.overlayProvider.overlay.get(url, false)) {
        unloadedOverlays.push(overlayUrl);
      }

      // Run through all overlay nodes on the first level (hookup nodes). Scripts will be deferred
      // until later for simplicity (c++ code seems to process them earlier?).
      for (let node of doc.documentElement.children) {
        if (node.localName == "script") {
          this.unloadedScripts.push(node);
        } else {
          forwardReferences.push(node);
        }
      }
    }

    // We've resolved all the forward references we can, we can now go ahead and load the scripts
    this.deferredLoad = [];
    for (let script of this.unloadedScripts) {
      this.deferredLoad.push(...this.loadScript(script));
    }

    let ids = xulStore.getIDsEnumerator(this.location);
    while (ids.hasMore()) {
      this.persistedIDs.add(ids.getNext());
    }

    // At this point, all (recursive) overlays are loaded. Unloaded scripts and sheets are ready and
    // in order, and forward references are good to process.
    let previous = 0;
    while (forwardReferences.length && forwardReferences.length != previous) {
      previous = forwardReferences.length;
      let unresolved = [];

      for (let ref of forwardReferences) {
        if (!this._resolveForwardReference(ref)) {
          unresolved.push(ref);
        }
      }

      forwardReferences = unresolved;
    }

    if (forwardReferences.length) {
      console.warn(
        `Could not resolve ${forwardReferences.length} references`,
        forwardReferences
      );
    }

    // Loading the sheets now to avoid race conditions with xbl bindings
    for (let sheet of unloadedSheets) {
      this.loadCSS(sheet);
    }

    this._decksToResolve = new Map();
    for (let id of this.persistedIDs.values()) {
      let element = this.document.getElementById(id);
      if (element) {
        let attrNames = xulStore.getAttributeEnumerator(this.location, id);
        while (attrNames.hasMore()) {
          let attrName = attrNames.getNext();
          let attrValue = xulStore.getValue(this.location, id, attrName);
          if (attrName == "selectedIndex" && element.localName == "deck") {
            this._decksToResolve.set(element, attrValue);
          } else if (
            (element != this.document.documentElement ||
            !["height", "screenX", "screenY", "sizemode", "width"].includes(
              attrName)) &&
            element.getAttribute(attrName) != attrValue.toString()
          ) {
            element.setAttribute(attrName, attrValue);
          }
        }
      }
    }

    if (this.document.readyState == "complete") {
      setTimeout(() => {
        this._finish();

        // Now execute load handlers since we are done loading scripts
        let bubbles = [];
        for (let { listener, useCapture } of this.deferredLoad) {
          if (useCapture) {
            this._fireEventListener(listener);
          } else {
            bubbles.push(listener);
          }
        }

        for (let listener of bubbles) {
          this._fireEventListener(listener);
        }
      });
    } else {
      this.document.defaultView.addEventListener(
        "load",
        this._finish.bind(this),
        { once: true }
      );
    }
  }

  _finish() {
    for (let [deck, selectedIndex] of this._decksToResolve.entries()) {
      deck.setAttribute("selectedIndex", selectedIndex);
    }

    for (let bar of this._toolbarsToResolve) {
      let currentset = Services.xulStore.getValue(
        this.location,
        bar.id,
        "currentset"
      );
      if (currentset) {
        bar.currentSet = currentset;
      } else if (bar.getAttribute("defaultset")) {
        bar.currentSet = bar.getAttribute("defaultset");
      }
    }
  }

  /**
   * Gets the overlays referenced by processing instruction on a document.
   *
   * @param {DOMDocument} document  The document to read instuctions from
   * @return {String[]}             URLs of the overlays from the document
   */
  _collectOverlays(doc) {
    let urls = [];
    let instructions = doc.evaluate(
      "/processing-instruction('xul-overlay')",
      doc,
      null,
      7,
      null
    );
    for (let i = 0, len = instructions.snapshotLength; i < len; ++i) {
      let node = instructions.snapshotItem(i);
      let match = node.nodeValue.match(/href=["']([^"']*)["']/);
      if (match) {
        urls.push(match[1]);
      }
    }
    return urls;
  }

  /**
   * Fires a "load" event for the given listener, using the current window
   *
   * @param {EventListener|Function} listener       The event listener to call
   */
  _fireEventListener(listener) {
    let fakeEvent = new this.window.UIEvent("load", { view: this.window });
    if (typeof listener == "function") {
      listener(fakeEvent);
    } else if (listener && typeof listener == "object") {
      listener.handleEvent(fakeEvent);
    } else {
      console.error("Unknown listener type", listener);
    }
  }

  /**
   * Resolves forward references for the given node. If the node exists in the target document, it
   * is merged in with the target node. If the node has no id it is inserted at documentElement
   * level.
   *
   * @param {Element} node          The DOM Element to resolve in the target document.
   * @return {Boolean}              True, if the node was merged/inserted, false otherwise
   */
  _resolveForwardReference(node) {
    if (node.id) {
      let target = this.document.getElementById(node.id);
      if (node.localName == "toolbarpalette") {
        // let box;
        // if(node.id == "BrowserToolbarPalette"){
        //   target = this.window.gNavToolbox.palette;
        //   box =  this.window.gNavToolbox;
        // }else{
        //   if (target) {
        //     box = target.closest("toolbox");
        //     } else {
        //       // These vanish from the document but still exist via the palette property
        //       let boxes = [...this.document.getElementsByTagName("toolbox")];
        //       box = boxes.find(box => box.palette && box.palette.id == node.id);
        //       let palette = box ? box.palette : null;
            
        //       if (!palette) {
        //         console.debug(
        //           `The palette for ${
        //             node.id
        //           } could not be found, deferring to later`
        //         );
        //         return false;
        //       }
            
        //       target = palette;
        //     }
        // } 

        // this._toolbarsToResolve.push(...box.querySelectorAll("toolbar"));
        // this._toolbarsToResolve.push(
        //   ...this.document.querySelectorAll(`toolbar[toolboxid="${box.id}"]`)
        // );

        var toolboxes = this.window.document.querySelectorAll('toolbox');
				for(let toolbox of toolboxes) {
					var palette = toolbox.palette;

					if(palette
					&& this.window.gCustomizeMode._stowedPalette
					&& this.window.gCustomizeMode._stowedPalette.id == node.id
					&& palette == this.window.gCustomizeMode.visiblePalette) {
						palette = this.window.gCustomizeMode._stowedPalette;
					}

					if(palette && (palette.id == node.id || (node.id == "BrowserToolbarPalette" && toolbox == this.window.gNavToolbox))) {
						buttons_loop: for(let button of node.childNodes) {
							if(button.id) {
								var existButton = this.window.document.getElementById(button.id);

								// If it's a placeholder created by us to deal with CustomizableUI, just use it.
								if(this.trueAttribute(existButton, 'CUI_placeholder')) {
									this.removeAttribute(existButton, 'CUI_placeholder');
									existButton.collapsed = false;
									this.appendButton(this.window, palette, existButton);
									continue buttons_loop;
								}

								// we shouldn't be changing widgets, or adding with same id as other nodes
								if(existButton) {
									continue buttons_loop;
								}

								// Save a copy of the widget node in the sandbox,
								// so CUI can use it when opening a new window without having to wait for the overlay.
								if(!Globals.widgets[button.id]) {
									Globals.widgets[button.id] = button;
								}

								// add the button if not found either in a toolbar or the palette
								button = this.window.document.importNode(button, true);
								this.appendButton(this.window, palette, button);
							}
						}
						break;
					}
				}
				return true;
      } else if (!target) {
        console.debug(
          `The node ${node.id} could not be found, deferring to later`
        );
        return false;
      }

      this._mergeElement(target, node);
    } else {
      this._insertElement(this.document.documentElement, node);
    }
    return true;
  }

  /**
   * Insert the node in the given parent, observing the insertbefore/insertafter/position attributes
   *
   * @param {Element} parent        The parent element to insert the node into.
   * @param {Element} node          The node to insert.
   */
  _insertElement(parent, node) {
    // These elements need their values set before they are added to
    // the document, or bad things happen.
    for (let element of node.querySelectorAll("menulist")) {
      if (element.id && this.persistedIDs.has(element.id)) {
        element.setAttribute(
          "value",
          Services.xulStore.getValue(this.location, element.id, "value")
        );
      }
    }

    if (node.localName == "toolbar") {
      this._toolbarsToResolve.push(node);
    } else {
      this._toolbarsToResolve.push(...node.querySelectorAll("toolbar"));
    }

    let nodes = node.querySelectorAll('script');
    for (let script of nodes) {
      this.deferredLoad.push(...this.loadScript(script));
    }

    let wasInserted = false;
    let pos = node.getAttribute("insertafter");
    let after = true;

    if (!pos) {
      pos = node.getAttribute("insertbefore");
      after = false;
    }

    if (pos) {
      for (let id of pos.split(",")) {
        let targetchild = this.document.getElementById(id);
        if (targetchild && targetchild.parentNode == parent) {
          parent.insertBefore(
            node,
            after ? targetchild.nextElementSibling : targetchild
          );
          wasInserted = true;
          break;
        }
      }
    }

    if (!wasInserted) {
      // position is 1-based
      let position = parseInt(node.getAttribute("position"), 10);
      if (position > 0 && position - 1 <= parent.children.length) {
        parent.insertBefore(node, parent.children[position - 1]);
        wasInserted = true;
      }
    }

    if (!wasInserted) {
      parent.appendChild(node);
    }
  }

  /**
   * Merge the node into the target, adhering to the removeelement attribute, merging further
   * attributes into the target node, and merging children as appropriate for xul nodes. If a child
   * has an id, it will be searched in the target document and recursively merged.
   *
   * @param {Element} target        The node to merge into
   * @param {Element} node          The node that is being merged
   */
  _mergeElement(target, node) {
    for (let attribute of node.attributes) {
      if (attribute.name == "id") {
        continue;
      }

      if (attribute.name == "removeelement" && attribute.value == "true") {
        target.remove();
        return;
      }

      target.setAttributeNS(
        attribute.namespaceURI,
        attribute.name,
        attribute.value
      );
    }

    for (let nodes of node.children) {
      if (nodes.localName == "script") {
        this.deferredLoad.push(...this.loadScript(nodes));
      } 
    }

    for (let i = 0, len = node.childElementCount; i < len; i++) {
      let child = node.firstElementChild;
      child.remove();

      let elementInDocument = child.id
        ? this.document.getElementById(child.id)
        : null;
      let parentId = elementInDocument ? elementInDocument.parentNode.id : null;

      if (parentId && parentId == target.id) {
        this._mergeElement(elementInDocument, child);
      } else {
        this._insertElement(target, child);
      }
    }
  }

  /**
   * Fetches the overlay from the given chrome:// or resource:// URL. This happen synchronously so
   * we have a chance to complete before the load event.
   *
   * @param {String} srcUrl                         The URL to load
   * @return {XMLHttpRequest}                       The completed XHR.
   */
  fetchOverlay(srcUrl) {
    if (!srcUrl.startsWith("chrome://") && !srcUrl.startsWith("resource://")) {
      throw new Error(
        "May only load overlays from chrome:// or resource:// uris"
      );
    }

    let xhr = new this.window.XMLHttpRequest();
    xhr.overrideMimeType("application/xml");
    xhr.open("GET", srcUrl, false);

    // Elevate the request, so DTDs will work. Should not be a security issue since we
    // only load chrome, resource and file URLs, and that is our privileged chrome package.
    try {
      xhr.channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
    } catch (ex) {
      console.error(
        "Failed to set system principal while fetching overlay " + srcUrl
      );
      xhr.close();
      throw new Error("Failed to set system principal");
    }

    xhr.send(null);
    return xhr;
  }

  /**
   * Loads scripts described by the given script node. The node can either have a src attribute, or
   * be an inline script with textContent.
   *
   * @param {Element} node                          The <script> element to load the script from
   * @return {Object[]}                             An object with listener and useCapture,
   *                                                  describing load handlers the script creates
   *                                                  when first run.
   */
  loadScript(node) {
    let deferredLoad = [];

    let oldAddEventListener = this.window.addEventListener;
    if (this.document.readyState == "complete") {
      this.window.addEventListener = function(
        type,
        listener,
        useCapture,
        ...args
      ) {
        if (type == "load") {
          if (typeof useCapture == "object") {
            useCapture = useCapture.capture;
          }

          if (typeof useCapture == "undefined") {
            useCapture = true;
          }
          deferredLoad.push({ listener, useCapture });
          return null;
        }
        return oldAddEventListener.call(
          this,
          type,
          listener,
          useCapture,
          ...args
        );
      };
    }

    if (node.hasAttribute("src")) {
      let url = new URL(node.getAttribute("src"), node.baseURI).href;
      console.debug(`Loading script ${url} into ${this.window.location}`);
      try {
        Services.scriptloader.loadSubScript(url, this.window);
      } catch (ex) {
        Cu.reportError(ex);
      }
    } else if (node.textContent) {
      console.debug(`Loading eval'd script into ${this.window.location}`);
      try {
        let dataURL =
          "data:application/javascript," + encodeURIComponent(node.textContent);
        // It would be great if we could have script errors show the right url, but for now
        // loadSubScript will have to do.
        Services.scriptloader.loadSubScript(dataURL, this.window);
      } catch (ex) {
        Cu.reportError(ex);
      }
    }

    if (this.document.readyState == "complete") {
      this.window.addEventListener = oldAddEventListener;
    }

    // This works because we only care about immediately executed addEventListener calls and
    // loadSubScript is synchronous. Everyone else should be checking readyState anyway.
    return deferredLoad;
  }

  /**
   * Load the CSS stylesheet from the given url
   *
   * @param {String} url        The url to load from
   * @return {Element}          An HTML link element for this stylesheet
   */
  loadCSS(url) {
    console.debug(`Loading ${url} into ${this.window.location}`);

    let winUtils = this.window.windowUtils;
    winUtils.loadSheetUsingURIString(url, winUtils.AUTHOR_SHEET);
  }

  trueAttribute(obj, attr) {
    if(!obj || !obj.getAttribute) { return false; }
  
    return (obj.getAttribute(attr) == 'true');
  };

  removeAttribute(obj, attr) {
    if(!obj || !obj.removeAttribute) { return; }
    obj.removeAttribute(attr);
  };

  appendButton(aWindow, palette, node) {
		if(!node.parentNode) {
			palette.appendChild(node);
		}
		var id = node.id;

		var widget = CustomizableUI.getWidget(id);
		if(!widget || widget.provider != CustomizableUI.PROVIDER_API) {
			// this needs the binding applied on the toolbar in order for the widget to be immediatelly placed there,
			// and since its placements won't be restored until it's created, we have to search for it in all existing areas
			var areaId = null;
			var areas = CustomizableUI.areas;
			for(let area of areas) {
				// this will throw if called too early for an area whose placements have not been fetched yet,
				// it's ok because once they are, the widget will be placed in it anyway
				try { var inArea = CustomizableUI.getWidgetIdsInArea(area); }
				catch(ex) { continue; }

				if(inArea.indexOf(id) > -1) {
					if(CustomizableUI.getAreaType(area) != CustomizableUI.TYPE_TOOLBAR) { break; }

					areaId = area;
					this.tempAppendAllToolbars(aWindow, area);
					break;
				}
			}

			try { CustomizableUI.createWidget(this.getWidgetData(aWindow, node, palette)); }
			catch(ex) { Cu.reportError(ex); }

			if(areaId) {
				this.tempRestoreAllToolbars(aWindow, areaId);
			}
		}

		else {
			var placement = CustomizableUI.getPlacementOfWidget(id, aWindow);
			var areaNode = (placement) ? aWindow.document.getElementById(placement.area) : null;
			if(areaNode && areaNode.nodeName == 'toolbar' && !areaNode._init) {
				this.tempAppendToolbar(aWindow, areaNode);
			}

			try { CustomizableUI.ensureWidgetPlacedInWindow(id, aWindow); }
			catch(ex) { Cu.reportError(ex); }

			if(areaNode) {
				this.tempRestoreToolbar(areaNode);
			}
		}

		// this.traceBack(aWindow, {
		// 	action: 'appendButton',
		// 	node: node
		// });
		return node;
  }
  
  tempAppendToolbar(aWindow, node) {
		if(node.tempAppend) {
			Cu.reportError('tempAppend already exists!');
			return;
		}

		node.tempAppend = {
			parent: node.parentNode,
			sibling: node.nextSibling,
			container: aWindow.document.createElement('box')
		};

		setAttribute(node.tempAppend.container, 'style', 'position: fixed; top: 4000px; left: 4000px; opacity: 0.001;');
		aWindow.document.documentElement.appendChild(node.tempAppend.container);

		try { node.tempAppend.container.appendChild(node); }
		catch(ex) { Cu.reportError(ex); }
	}

	tempRestoreToolbar(node) {
		if(node.tempAppend) {
			try { node.tempAppend.parent.insertBefore(node.tempAppend.container.firstChild, node.tempAppend.sibling); }
			catch(ex) { Cu.reportError(ex); }

			node.tempAppend.container.parentNode.removeChild(node.tempAppend.container);
			delete node.tempAppend;
		}
	}

	tempAppendAllToolbars(aWindow, aToolbarId) {
		Windows.callOnAll((bWindow) => {
			var wToolbar = bWindow.document.getElementById(aToolbarId);
			if(wToolbar && !wToolbar._init) {
				this.tempAppendToolbar(bWindow, wToolbar);
			}
		}, aWindow.document.documentElement.getAttribute('windowtype'));
	}

	tempRestoreAllToolbars(aWindow, aToolbarId) {
		Windows.callOnAll((bWindow) => {
			var wToolbar = bWindow.document.getElementById(aToolbarId);
			if(wToolbar) {
				this.tempRestoreToolbar(wToolbar);
			}
		}, aWindow.document.documentElement.getAttribute('windowtype'));
  }
  
  getWidgetData(aWindow, node, palette) {
		var data = {
			removable: true // let's default this one
		};

		if(node.attributes) {
			for(let attr of node.attributes) {
				if(attr.value == 'true') {
					data[attr.name] = true;
				} else if(attr.value == 'false') {
					data[attr.name] = false;
				} else {
					data[attr.name] = attr.value;
				}
			}
		}

		// createWidget() defaults the removable state to true as of bug 947987
		if(!data.removable && !data.defaultArea) {
			data.defaultArea = (node.parentNode) ? node.parentNode.id : palette.id;
		}

		if(data.type == 'custom') {
			data.palette = palette;

			data.onBuild = function(aDocument, aDestroy) {
				// Find the node in the DOM tree
				var node = aDocument.getElementById(this.id);

				// If it doesn't exist, find it in a palette.
				// We make sure the button is in either place at all times.
				if(!node) {
					var toolboxes = aDocument.querySelectorAll('toolbox');
					toolbox_loop: for(let toolbox of toolboxes) {
						var palette = toolbox.palette;
						if(!palette) { continue; }

						if(palette == aDocument.defaultView.gCustomizeMode.visiblePalette) {
							palette = aDocument.defaultView.gCustomizeMode._stowedPalette;
						}
						for(let child of palette.childNodes) {
							if(child.id == this.id) {
								node = child;
								break toolbox_loop;
							}
						}
					}
				}

				// If it doesn't exist there either, CustomizableUI is using the widget information before it has been overlayed (i.e. opening a new window).
				// We get a placeholder for it, then we'll replace it later when the window overlays.
				if(!node && !aDestroy) {
					var node = aDocument.importNode(Globals.widgets[this.id], true);
					setAttribute(node, 'CUI_placeholder', 'true');
					node.collapsed = true;
				}

				return node;
			};

			// unregisterArea()'ing the toolbar can nuke the nodes, we need to make sure ours are moved to the palette
			data.onWidgetAfterDOMChange = function(aNode) {
				if(aNode.id == this.id
				&& !aNode.parentNode
				&& !trueAttribute(aNode.ownerDocument.documentElement, 'customizing') // it always ends up in the palette in this case
				&& this.palette) {
					this.palette.appendChild(aNode);
				}
			};

			data.onWidgetDestroyed = function(aId) {
				if(aId == this.id) {
					Windows.callOnAll((aWindow) => {
						var node = data.onBuild(aWindow.document, true);
						if(node) { node.remove(); }
					}, 'navigator:browser');
					CustomizableUI.removeListener(this);
				}
			};

			CustomizableUI.addListener(data);
		}

		return data;
	}

}
