"use strict";
"use client";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.CPContext = void 0;
exports.CPRootProvider = CPRootProvider;
var _react = _interopRequireWildcard(require("react"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
const CPContext = exports.CPContext = /*#__PURE__*/(0, _react.createContext)(null);
function CPRootProvider({
  children
}) {
  return /*#__PURE__*/_react.default.createElement(CPContext.Provider, {
    value: null
  }, children);
}
