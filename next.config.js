/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit `.next/standalone/server.js` + pruned node_modules so the Docker
  // runtime image can `node server.js` with a minimal footprint.
  output: "standalone",
  // better-sqlite3 ships its compiled binding as a .node file that Next's
  // standalone tracer doesn't follow automatically. Pin it into the output.
  outputFileTracingIncludes: {
    "/**/*": ["node_modules/better-sqlite3/build/Release/*.node"],
  },
};

module.exports = nextConfig;
