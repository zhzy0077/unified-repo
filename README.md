# Unified Fedora repository

A Cloudflare Worker combines RPM packages from multiple sources into one DNF repository. It generates metadata on request and redirects RPM downloads to their original servers. GitHub RPM metadata is cached in Cloudflare KV; RPMs are not stored.

The default sources are Ghostty and GlobalProtect-openconnect on COPR, Microsoft's VS Code and RHEL 10 repositories, Cloudflare's cloudflared repository, and the latest stable GitHub releases of Deskflow, teams-for-linux, and Clash Verge Rev.

## Run and deploy

Requires Node.js and npm.

```sh
npm install
npm run dev
npm run typecheck
npm run deploy
```

Edit [src/sources.ts](src/sources.ts) to change the upstream RPM repositories or GitHub sources. RPM repository URLs can contain `$releasever` and `$basearch`; the GitHub asset pattern is a regular expression using the same placeholders. The repository supports `x86_64` and `aarch64`.

Create `/etc/yum.repos.d/unified.repo`:

```ini
[unified]
name=Unified repository
baseurl=https://repo.zhzy.workers.dev/repo/$releasever/$basearch/
enabled=1
gpgcheck=0
```

The Deskflow Fedora 44 RPM is unsigned, so this example disables RPM signature verification for the entire unified repository. To require signatures, set `gpgcheck=1` and configure trusted signing keys for all sources; unsigned packages will then fail verification.

The generated repository currently supplies primary metadata; filelists and changelog metadata are not generated. GitHub package dependencies are read from RPM headers and cached in KV for 30 days by asset SHA-256 and size. The release API supplies the SHA-256 and size; assets without a SHA-256 digest cannot be indexed. COPR and other RPM repositories already provide package metadata, so their RPM headers are not downloaded. Metadata is regenerated for each request; its checksum detects upstream changes between requests, in which case DNF must refresh. Upstream availability, GitHub API rate limits, and Worker resource limits affect refreshes.

For local testing, run `npm run dev -- --ip 0.0.0.0`, then use `http://127.0.0.1:8787/repo/44/$basearch/` from a Fedora 44 container with host networking.
