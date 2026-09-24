import { frontendEnv } from "@gospaza/config/env";

frontendEnv(process.env, true);

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@gospaza/ui", "@gospaza/contracts", "@gospaza/api-client"],
};
export default config;
