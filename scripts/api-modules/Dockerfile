# Builds the API's production node_modules from the pnpm lockfile, on the
# server's platform: Amazon Linux 2023, x86-64. Native modules (argon2, sharp,
# @napi-rs/canvas) and Prisma's engines are fetched or built for this platform,
# not the Mac's. Node 22 runs pnpm 11; the modules are N-API, so they load on
# the server's Node too (checked by scripts/build-api-modules.mjs).
FROM --platform=linux/amd64 amazonlinux:2023
RUN dnf install -y nodejs22 nodejs22-npm tar gzip findutils && dnf clean all \
 && ln -sf /usr/bin/node-22 /usr/local/bin/node && ln -sf /usr/bin/npm-22 /usr/local/bin/npm \
 && npm install -g pnpm@11.17.0
WORKDIR /src
