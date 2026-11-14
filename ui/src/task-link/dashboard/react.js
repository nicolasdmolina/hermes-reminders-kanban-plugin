// `react` for the browser dashboard bundle: the host's React from its plugin SDK
// (window.__HERMES_PLUGIN_SDK__), never a bundled copy.
const React = globalThis.__HERMES_PLUGIN_SDK__?.React

export default React
export const { createContext, createElement, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } = React ?? {}
