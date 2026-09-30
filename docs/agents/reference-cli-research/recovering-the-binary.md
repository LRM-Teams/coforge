# Recovering the binary and its source

The release authority is the Hands API, not the CDN. The per-version CDN
manifest (`cdn.raft.build/computer/<version>/manifest.json`, which redirects
to `cdn.slock.ai`) exists through 1.0.32 and is a 404 from 1.0.36 on, so
1.0.38 has none. Verified on 2026-09-30 for `darwin-arm64`.

## Download and verify

1. Resolve the release. `updates/check` with `version` pins one version:

   ```sh
   H=https://hands.build/public/v2/apps/raft-computer-cli
   curl -fsSL "$H/updates/check?product_type=cli-binary&platform=darwin&arch=arm64&current_version=0.0.0&current_version_code=0&version=1.0.38"
   ```

   `release.id` is `4faf5666-ed46-41a8-be62-f99108af72c5`. `artifact` carries
   `sha256`, a `gzip` entry, and a `photon_wasm` entry, each with a stable
   `download_url`. `latest?channel=latest&product_type=cli-binary` cannot pin
   a version and returns expiring signed R2 URLs, so do not record them.
   `versions?platform=darwin&arch=arm64` (optional `channel`, `limit`) lists
   each release's id, sha256, and size; use it to find any version.

2. Download the gzipped binary and verify it.

   ```sh
   R=https://hands.build/dl/raft-computer-cli/releases/4faf5666-ed46-41a8-be62-f99108af72c5
   curl -fsSL -o raft.gz "$R/darwin-arm64.gz"   # gzip sha256 5208b34e94efdb340eb739ee354840b522a3251935afd5a6e23190453107e8c0
   gunzip raft.gz
   shasum -a 256 raft   # expect d6973542b7f0ec1b12f062afdaf35cdeff3e803986452452cb77bbe728fe049d
   ```

   The build also ships `photon_rs_bg.wasm` (`$R/darwin-arm64?kind=photon-wasm`,
   sha256 `10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c`)
   as a sidecar beside the binary; it is not inside the SEA.

The user-facing install is
`curl -fsSL https://cdn.raft.build/computer/install.sh | RAFT_COMPUTER_VERSION=1.0.38 sh`.
The script only downloads the separate [installer](installer.md), verifies it
against a `SHA256SUMS` list, runs `install` with `RAFT_COMPUTER_VERSION` as
`--version`, and reruns it once if the installer exits 3 (unresolved). It was
read, not run.

## Extract the source

The binary is a Node.js single-executable application (SEA): a stock Node
24.15.0 binary with a plain-text JS bundle injected by postject into a
`NODE_SEA` segment (not a V8 snapshot or code cache). The steps are the same
as for earlier builds; only the inputs above changed.

1. Locate the blob and cut it out.

   ```sh
   otool -l raft | grep -A8 'sectname __NODE_SEA_BLOB'
   ```

   Slice the file at the section `offset` (91160576) for its `size`
   (0x2843ec3, 42221251 bytes); the `NODE_SEA` segment `fileoff` and
   `filesize` give the same bytes, and only its `vmsize` is page-rounded. Not
   re-verified for other targets: on Linux use `readelf -S` and
   `NODE_SEA_BLOB`; on Windows it is a resource of the same name.

2. Strip the SEA header. The blob begins with a magic number, flags, a
   length-prefixed build path, then the JS text, which starts with a version
   banner (at blob offset 124):

   ```python
   blob = open("sea.bin", "rb").read()
   start = blob.find(b"/* raft-computer SEA bundle v1.0.38 */")
   open("raft-computer-1.0.38.cjs", "wb").write(blob[start:])
   ```

   Confirm the banner says `v1.0.38` before going further.

3. Split the bundle at path comments: lines matching
   `^// (packages|node_modules)/\S+$`, for example
   `// packages/computer/src/cli.ts` or `// node_modules/.pnpm/<dep>/...`.
   Write the text from one marker to the next into a file at that path. Other
   `//` comments (`// @__NO_SIDE_EFFECTS__`, the closing export annotation)
   are not markers. The tail repeats the `packages/computer/src/index.ts`
   marker, so append when a path already exists.

Do this in the session scratchpad. Never commit the binary or the extracted
tree to this repository.
