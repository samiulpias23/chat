import type { MetadataRoute } from 'next';

// iOS only allows web push for sites added to the Home Screen
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ChatAf',
    short_name: 'ChatAf',
    start_url: '/rooms',
    display: 'standalone',
    background_color: '#0E1621',
    theme_color: '#0E1621',
  };
}
