const config = {
  async redirects() {
    return [{ source: '/legacy/:id', destination: '/orders/:id', permanent: true }];
  },
};
export default config;
