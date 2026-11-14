# Third-party notices

The project's MIT license does not replace the licenses of third-party material.

## Visual Studio Code Codicons

The inline icons in `ui/src/task-link/dashboard/sdk.js` adapt shapes from
[Visual Studio Code Codicons](https://github.com/microsoft/vscode-codicons)
by Microsoft Corporation. The adaptations use simplified SVG paths for the
browser task view.

The icons are licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
The full license is included in [licenses/codicons.txt](licenses/codicons.txt).
The upstream license was checked at commit
[`6200d186bea39354a18737cfff73fe19dbc5fcff`](https://github.com/microsoft/vscode-codicons/blob/6200d186bea39354a18737cfff73fe19dbc5fcff/LICENSE).

## Host and development dependencies

Hermes supplies React and the Desktop plugin SDK at runtime. These packages are
not bundled in this plugin. Build and test dependencies are installed separately
from `ui/package-lock.json` and `uv.lock` and retain their own licenses.
