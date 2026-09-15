import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["tesseract.js", "@tesseract.js-data/eng"],
};

export default nextConfig;
