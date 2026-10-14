import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Native/heavy AI packages must stay outside the server bundle (loaded at runtime via require)
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
