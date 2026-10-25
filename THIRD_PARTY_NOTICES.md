# Third-party software

The runner source is MIT licensed; see `LICENSE`. Container dependencies retain
their own licenses. Debian package notices and license texts remain under
`/usr/share/doc/`; Node's license remains under `/usr/local/LICENSE`. Installed
JavaScript dependencies retain their license files in `node_modules`.

The image includes the unmodified official Proton Drive CLI executable. Its
version and checksum are pinned in `Dockerfile`. Upstream source and its dependency
notices are available at https://github.com/ProtonDriveApps/sdk/tree/cli/v0.8.0
(revision `5491f2eea473acaaa86b5969774b84610a37bd46`). The executable embeds Bun;
Bun's license and third-party notices are available at https://bun.com/docs/project/license.
The runner's MIT license does not change those licenses or Proton's service terms.

## Proton Drive SDK and CLI

The MIT License

Copyright (c) 2025-2026 Proton AG

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
