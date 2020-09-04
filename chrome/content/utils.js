"use strict";

var Tabmix = {
  get prefs() {
    delete this.prefs;
    return (this.prefs = Services.prefs.getBranch("extensions.tabmix."));
  },

  get defaultPrefs() {
    delete this.defaultPrefs;
    return (this.defaultPrefs = Services.prefs.getDefaultBranch("extensions.tabmix."));
  },

  isVersion() {
    return TabmixSvc.version.apply(null, arguments);
  },

  // for debug
  debug: function TMP_utils_debug(aMessage, aShowCaller) {
    if (this._debug)
      this.log(aMessage, aShowCaller);
  },

  // Show/hide one item (specified via name or the item element itself).
  showItem(aItemOrId, aShow) {
    var item = typeof (aItemOrId) == "string" ? document.getElementById(aItemOrId) : aItemOrId;
    if (item && item.hidden == Boolean(aShow))
      item.hidden = !aShow;
  },

  setItem(aItemOrId, aAttr, aVal) {
    var elem = typeof (aItemOrId) == "string" ? document.getElementById(aItemOrId) : aItemOrId;
    if (elem) {
      if (aVal === null || aVal === undefined) {
        elem.removeAttribute(aAttr);
        return;
      }
      if (typeof (aVal) == "boolean")
        aVal = aVal ? "true" : "false";

      if (!elem.hasAttribute(aAttr) || elem.getAttribute(aAttr) != aVal)
        elem.setAttribute(aAttr, aVal);
    }
  },

  setAttributeList(aItemOrId, aAttr, aValue, aAdd) {
    let elem = typeof (aItemOrId) == "string" ? document.getElementById(aItemOrId) : aItemOrId;
    let att = elem.getAttribute(aAttr);
    let array = att ? att.split(" ") : [];
    let index = array.indexOf(aValue);
    if (aAdd && index == -1)
      array.push(aValue);
    else if (!aAdd && index != -1)
      array.splice(index, 1);
    if (array.length)
      elem.setAttribute(aAttr, array.join(" "));
    else
      elem.removeAttribute(aAttr);
  },

  getBoundsWithoutFlushing(element) {
    if (!("_DOMWindowUtils" in this)) {
      try {
        this._DOMWindowUtils =
          window.QueryInterface(Ci.nsIInterfaceRequestor)
              .getInterface(Ci.nsIDOMWindowUtils);
        if (!this._DOMWindowUtils.getBoundsWithoutFlushing) {
          this._DOMWindowUtils = null;
        }
      } catch (ex) {
        this._DOMWindowUtils = null;
      }
    }
    return this._DOMWindowUtils ?
      this._DOMWindowUtils.getBoundsWithoutFlushing(element) :
      element.getBoundingClientRect();
  },

  getTopWin() {
    return Services.wm.getMostRecentWindow("navigator:browser");
  },

  skipSingleWindowModeCheck: false,
  getSingleWindowMode: function TMP_getSingleWindowMode() {
    // if we don't have any browser window opened return false
    // so we can open new window
    if (this.skipSingleWindowModeCheck || !this.getTopWin()) {
      return false;
    }
    return this.prefs.getBoolPref("singleWindow");
  },

  isNewWindowAllow(isPrivate) {
    // allow to open new window if:
    //   user are not in single window mode or
    //   there is no other window with the same privacy type
    return !this.getSingleWindowMode() ||
      !this.RecentWindow.getMostRecentBrowserWindow({private: isPrivate});
  },

  lazy_import(aObject, aName, aModule, aSymbol, aFlag, aArg) {
    if (aFlag)
      this[aModule + "Initialized"] = false;
    var self = this;
    XPCOMUtils.defineLazyGetter(aObject, aName, () => {
      let tmp = {};
      Components.utils.import("resource://tabmixplus/" + aModule + ".jsm", tmp);
      let Obj = tmp[aSymbol];
      if ("prototype" in tmp[aSymbol])
        Obj = new Obj();
      else if ("init" in Obj)
        Obj.init.apply(Obj, aArg);
      if (aFlag)
        self[aModule + "Initialized"] = true;
      return Obj;
    });
  },

  backwardCompatibilityGetter(aObject, aOldName, aNewName) {
    if (aOldName in aObject)
      return;

    var self = this;
    Object.defineProperty(aObject, aOldName, {
      get() {
        self.informAboutChangeInTabmix(aOldName, aNewName);
        delete aObject[aOldName];
        return (aObject[aOldName] = self.getObject(window, aNewName));
      },
      configurable: true
    });
  },

  informAboutChangeInTabmix(aOldName, aNewName) {
    let err = Error(aOldName + " is deprecated in Tabmix, use " + aNewName + " instead.");
    // cut off the first lines, we looking for the function that trigger the getter.
    let stack = Error().stack.split("\n").slice(3);
    let stackData = stack[0] ? stack[0].split("@") : null;
    if (stackData && stackData.length == 2) {
      let [path, line] = stackData[1].replace("chrome://", "").split(":");
      let index = path.indexOf("/") - 1;
      let extensionName = index > -1 ?
        path.charAt(0).toUpperCase() + path.substr(1, index) + " " : "";
      this.clog(err.message + "\n\n" + extensionName + "extension call " + aOldName +
                 " from:\nfile: chrome://" + path + "\nline: " + line +
                 "\n\nPlease inform Tabmix Plus developer" +
                 (extensionName ? (" and " + extensionName + "developer.") : "."));
    } else {
      this.clog(err.message + "\n\n" + stack);
    }
  },

  promptService(intParam, strParam, aWindow, aCallBack) {
    var dpb = Cc["@mozilla.org/embedcomp/dialogparam;1"]
        .createInstance(Ci.nsIDialogParamBlock);
    // intParam[0] - default button accept=0, cancel=1, extra1=2
    // intParam[1] - show menuList= 1 , show textBox= 0, hide_both= 2
    // intParam[2] - set checkbox checked  true=1 , false=0, hide=2
    // intParam[3] - flag  - for menuList contents: flag to set menu selected item
    //                     - for textBox rename: 1 , save: 0
    ///XXX temp fix
    // intParam[4] - flag  - 1 - use Tabmix.Sessions.createMenuForDialog

    // we use non modal dialog when we call for prompt on startup
    // when we don't have a callBack function use modal dialog
    let modal = typeof (aCallBack) != "function";
    var i;
    for (i = 0; i < intParam.length; i++)
      dpb.SetInt(i, intParam[i]);
    // strParam labels for: title, msg, testbox.value, checkbox.label, buttons[]
    // buttons[]: labels array for each button
    for (i = 0; i < strParam.length; i++)
      dpb.SetString(i, strParam[i]);

    if (typeof (aWindow) == "undefined") {
      try {
        aWindow = window;
      } catch (e) {
        aWindow = null;
      }
    }

    // we add dependent to features to make this dialog float over the window on start
    var dialog = Services.ww.openWindow(aWindow,
      "chrome://tabmixplus/content/dialogs/promptservice.xul", "", "centerscreen" +
           (modal ? ",modal" : ",dependent"), dpb);
    if (!modal)
      dialog._callBackFunction = aCallBack;

    return {
      button: dpb.GetInt(4),
      checked: (dpb.GetInt(5) == this.CHECKBOX_CHECKED),
      label: dpb.GetString(5),
      value: dpb.GetInt(6)
    };
  },

  windowEnumerator: function Tabmix_windowEnumerator(aWindowtype) {
    if (typeof (aWindowtype) == "undefined")
      aWindowtype = "navigator:browser";
    return Services.wm.getEnumerator(aWindowtype);
  },

  numberOfWindows: function Tabmix_numberOfWindows(all, aWindowtype) {
    var enumerator = this.windowEnumerator(aWindowtype);
    var count = 0;
    while (enumerator.hasMoreElements()) {
      let win = enumerator.getNext();
      let isClosed = "TabmixSessionManager" in win &&
          win.TabmixSessionManager.windowClosed;
      if (!isClosed) {
        count++;
        if (!all && count == 2)
          break;
      }
    }
    return count;
  },

  get isSingleBrowserWindow() {
    return this.numberOfWindows(false, "navigator:browser") == 1;
  },

  get isLastBrowserWindow() {
    return this.isSingleBrowserWindow;
  },

  get window() {
    return window;
  },

  compare: function TMP_utils_compare(a, b, lessThan) {
    return lessThan ? a < b : a > b;
  },

  itemEnd: function TMP_utils_itemEnd(item, end) {
    return item.boxObject.screenX + (end ? item.getBoundingClientRect().width : 0);
  },

  show(aMethod, aDelay, aWindow) {
    TabmixSvc.console.show(aMethod, aDelay, aWindow || window);
  },

  // console._removeInternal use this function name to remove it from
  // caller list
  _getMethod: function TMP_console_wrapper(id, args) {
    if (["changeCode", "setNewFunction", "nonStrictMode"].indexOf(id) > -1) {
      this.installChangecode();
      return this[id].apply(this, args);
    }
    if (typeof TabmixSvc.console[id] == "function") {
      return TabmixSvc.console[id].apply(TabmixSvc.console, args);
    }
    TabmixSvc.console.trace("unexpected method " + id);
    return null;
  },

  installChangecode() {
    Services.scriptloader.loadSubScript("chrome://tabmixplus/content/changecode.js", window);
    this.installChangecode = function() {};
  },

  _init() {
    Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
    Components.utils.import("resource://gre/modules/Services.jsm");
    XPCOMUtils.defineLazyModuleGetter(this, "RecentWindow",
      "resource:///modules/RecentWindow.jsm");

    const destroy = () => {
      window.removeEventListener("unload", destroy);
      this.destroy();
    };
    window.addEventListener("unload", destroy);

    var methods = ["changeCode", "setNewFunction", "nonStrictMode",
      "getObject", "log", "getCallerNameByIndex", "callerName",
      "clog", "isCallerInList", "callerTrace",
      "obj", "assert", "trace", "reportError"];
    methods.forEach(function(id) {
      this[id] = function TMP_console_wrapper() {
        return this._getMethod(id, arguments);
      }.bind(this);
    }, this);
  },

  originalFunctions: {},
  destroy: function TMP_utils_destroy() {
    this.toCode = null;
    this.originalFunctions = null;
    delete this.window;
  }
};

Tabmix._init();
Tabmix.lazy_import(window, "TabmixSvc", "TabmixSvc", "TabmixSvc");
