/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('onnxruntime-node');
    }
    return config;
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_SOCKET_URL;
    if (backendUrl) {
      return [
        {
          source: '/api/:path*',
          destination: `${backendUrl.replace(/\/$/, '')}/api/:path*`,
        },
        {
          source: '/socket.io/:path*',
          destination: `${backendUrl.replace(/\/$/, '')}/socket.io/:path*`,
        },
      ];
    }
    return [];
  }
};

module.exports = nextConfig;
