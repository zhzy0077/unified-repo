// Edit these sources and deploy the Worker to change the unified repository.
export const sources = {
  repositories: [
    { id: 'ghostty', baseUrl: 'https://download.copr.fedorainfracloud.org/results/scottames/ghostty/fedora-$releasever-$basearch/' },
    { id: 'globalprotect', baseUrl: 'https://download.copr.fedorainfracloud.org/results/yuezk/globalprotect-openconnect/fedora-$releasever-$basearch/' },
    { id: 'vscode', baseUrl: 'https://packages.microsoft.com/yumrepos/vscode/' },
    { id: 'microsoft', baseUrl: 'https://packages.microsoft.com/rhel/10/prod/' },
    { id: 'cloudflared', baseUrl: 'https://pkg.cloudflare.com/cloudflared/rpm/' },
  ],
  github: { repository: 'deskflow/deskflow', assetPattern: '^deskflow-[^-]+-fedora-$releasever-$basearch\\.rpm$' },
} as const;
