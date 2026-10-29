# Unified Fedora repository

One DNF repository for RPM packages from COPR, vendor repositories, and GitHub Releases. A Cloudflare Worker combines their package metadata and redirects RPM downloads to the original servers.

The public instance is available at [repo.zhzy.workers.dev](https://repo.zhzy.workers.dev/).

## Install on Fedora

Add the repository with DNF5:

```sh
sudo dnf config-manager addrepo --id=unified --set='baseurl=https://repo.zhzy.workers.dev/repo/$releasever/$basearch/' --set=gpgcheck=0
```

Refresh the metadata and look up a package:

```sh
sudo dnf makecache
dnf repoquery --repo=unified teams-for-linux
```

Install packages normally, for example `sudo dnf install ghostty`. The repository supports `x86_64` and `aarch64`; availability depends on whether each upstream publishes a matching RPM for your architecture and Fedora release.

**Signature verification:** The example sets `gpgcheck=0` for the entire unified repository because some upstream RPMs are unsigned. DNF therefore does not verify RPM signatures from this repository. To require signatures, set `gpgcheck=1` and configure the trusted upstream signing keys; unsigned packages will fail verification.

## Sources

| Source | Packages |
| --- | --- |
| [scottames/ghostty COPR](https://copr.fedorainfracloud.org/coprs/scottames/ghostty/) | Ghostty |
| [yuezk/globalprotect-openconnect COPR](https://copr.fedorainfracloud.org/coprs/yuezk/globalprotect-openconnect/) | GlobalProtect-openconnect |
| [Microsoft VS Code](https://packages.microsoft.com/yumrepos/vscode/) | VS Code |
| [Microsoft RHEL 10 production](https://packages.microsoft.com/rhel/10/prod/) | Microsoft packages, including PowerShell |
| [Cloudflare cloudflared](https://pkg.cloudflare.com/cloudflared/rpm/) | cloudflared |
| [deskflow/deskflow](https://github.com/deskflow/deskflow/releases) | Deskflow |
| [IsmaelMartinez/teams-for-linux](https://github.com/IsmaelMartinez/teams-for-linux/releases) | teams-for-linux |
| [Clash-Verge-rev/clash-verge-rev](https://github.com/Clash-Verge-rev/clash-verge-rev/releases) | Clash Verge Rev |

GitHub sources follow the latest stable release and select RPM assets matching the configured filename pattern. A release that has no matching Fedora-version or architecture asset contributes no package for that request.

## How it works

The Worker reads primary RPM metadata from each configured repository and reads RPM headers for GitHub release assets. It combines package records into one repository and serves `repomd.xml` and primary metadata for each Fedora release and architecture. Package download URLs return HTTP 302 redirects to the upstream RPMs; the Worker does not store or proxy their payloads.

GitHub RPM metadata is cached in Workers KV for 30 days, keyed by the release asset's SHA-256 digest and size. The digest and size come from the GitHub release API; assets without a SHA-256 digest are not indexed. COPR and other RPM repositories already provide package metadata, so their RPM headers do not need to be fetched.

The Worker fetches upstream metadata on each repository metadata request, with up to four sources processed concurrently. It generates primary metadata only; filelists and changelog metadata are not provided. A checksum in the primary metadata URL detects a change between requests; refresh DNF metadata if the upstream snapshot changes.

## Develop and deploy

Install Node.js and npm, then run:

```sh
npm install
npm run dev
npm run typecheck
```

Edit [src/sources.ts](src/sources.ts) to configure sources. RPM repository base URLs support `$releasever` and `$basearch`. GitHub asset patterns are regular expressions with the same placeholders. After changing Worker bindings or compatibility settings, run `npm run cf-typegen` to regenerate the Workers types.

For your own deployment, create a Workers KV namespace, set its ID for the `RPM_METADATA` binding in [wrangler.jsonc](wrangler.jsonc), and choose a Worker name. Authenticate with `npx wrangler login`, then deploy:

```sh
npx wrangler kv namespace create repo-github-rpm-metadata
npm run deploy
```

To configure GitHub API authentication for the Worker, set a Cloudflare Workers secret:

```sh
npx wrangler secret put GITHUB_TOKEN
```

Paste your GitHub API token at the prompt. The Worker uses this secret for release lookups at `https://api.github.com`, so repository clients can use the same public URL. Authenticated requests use the token's GitHub API quota. For local development, set `GITHUB_TOKEN` in a gitignored `.dev.vars` file.

The included configuration targets the public instance. Change the Worker name, namespace ID, and setup URL in `src/index.ts` for a separate deployment.

For a local Fedora 44 container test, start the Worker with `npm run dev -- --ip 0.0.0.0` and use `http://127.0.0.1:8787/repo/44/$basearch/` as the repository base URL in a Podman container running with host networking.
