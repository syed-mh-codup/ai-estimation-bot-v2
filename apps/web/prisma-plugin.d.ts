// The Prisma monorepo workaround plugin ships no type declarations. It's a
// standard webpack plugin (has an `apply(compiler)` method); declare just that.
declare module '@prisma/nextjs-monorepo-workaround-plugin' {
  export class PrismaPlugin {
    apply(compiler: unknown): void;
  }
}
