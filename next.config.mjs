/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow local LAN devices and IP connections during development
  allowedDevOrigins: [
    '192.168.0.200',
    '169.254.83.107',
    '172.23.208.1',
    'localhost',
    '127.0.0.1',
  ],
};

export default nextConfig;
