// `react/jsx-runtime` for the browser dashboard bundle, built on the host's createElement.
import React from './react.js'

export const Fragment = React?.Fragment
export function jsx(type, props, key) {
  return React.createElement(type, key === undefined ? props : { ...props, key })
}
export const jsxs = jsx
