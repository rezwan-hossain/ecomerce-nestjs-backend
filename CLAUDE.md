# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run start:dev          # start with watch mode
npm run start:debug        # start with watch + debugger

# Build
npm run build

# Lint / format
npm run lint                # eslint --fix over src/apps/libs/test
npm run format               # prettier --write src/**/*.ts test/**/*.ts

# Tests (Jest)
npm run test                 # unit tests (*.spec.ts, run from src/)
npm run test:watch
npm run test:cov
npm run test:e2e             # e2e tests (test/*.e2e-spec.ts), separate jest config: test/jest-e2e.json
npx jest path/to/file.spec.ts                 # run a single unit test file
npx jest -t "test name"                       # run tests matching a name
npx jest --config ./test/jest-e2e.json path/to/file.e2e-spec.ts   # single e2e test

# Prisma
npx prisma generate          # regenerate client into src/generated/prisma (run after schema.prisma changes)
npx prisma migrate dev        # create/apply a migration in dev
npx prisma studio
```

Unit tests live next to the code they test (`*.spec.ts`, Jest `rootDir` is `src`). E2E tests live under `test/` and use `test/jest-e2e.json`.

## Environment

Requires `DATABASE_URL` (PostgreSQL) in `.env`, loaded via `dotenv/config`. Prisma connects through `@prisma/adapter-pg` (driver adapter), not the default Prisma engine — see `src/prisma/prisma.service.ts`.

## Architecture

NestJS 11 + Prisma 7 (postgres) backend with Zod-based validation (`nestjs-zod`) instead of `class-validator`.

- **Prisma client is custom-generated.** `prisma/schema.prisma` outputs the client to `src/generated/prisma` (not `node_modules/@prisma/client`), using `moduleFormat: cjs`. This generated output is checked into the repo — after editing `schema.prisma`, run `npx prisma generate` and the diff in `src/generated/prisma/**` is expected/required, not accidental.
- **DTOs are Zod schemas, not classes with decorators.** Each module defines schemas with `z.object(...)` and wraps them via `createZodDto()` from `nestjs-zod` (see `src/modules/products/dto/product.dto.ts`, `src/modules/categories/dto/categories.dto.ts`). Validation is enforced globally through `ZodValidationPipe` registered as `APP_PIPE` in `app.module.ts` (also passed to `useGlobalPipes` in `main.ts`).
- **Module layout**: each domain lives under `src/modules/<name>/` with `<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts`, and a `dto/` folder. `PrismaModule` (`src/prisma/`) is imported per-module to inject `PrismaService`.
- **Product domain is the core of the data model** (`prisma/schema.prisma`): `Product` has many `ProductVariant`s (SKU + price/stock), and variants are defined by combinations of `Option`/`OptionValue` pairs (e.g. Color=Red, Size=XL) joined through `VariantOptionValue`. Products also relate to `Category`/`Tag`/`Brand` via join tables (`ProductCategory`, `ProductTag`), and have their own `ProductImage`s plus per-variant `VariantImage`s. `VariantTemplate`/`TemplateOption`/`TemplateOptionValue` exist to predefine reusable option sets (e.g. "Shoe Sizes") but aren't yet wired into product creation.
- **Variant validation is the trickiest logic** in the codebase: `ProductsService.validateOptionValueIds()` (in `products.service.ts`) checks that every provided `optionValueId` exists, belongs to a declared `optionId`, that each variant supplies exactly one value per declared option, and that no two variants share the same option-value combination. It's reused by both `createProduct()` and `addVariant()`.
- **Product creation is transactional**: `createProduct()` builds the product, images, category/tag/option links, and all variants (with their option-value links and images) inside a single `prisma.$transaction`. Slugs are auto-derived via `src/common/utils/slug.util.ts` (`createSlug` / `generateSlugWithUUID`), falling back to a UUID-suffixed slug only when no explicit `slug`/`name` collision resolution is required; an explicit slug/name collision throws `ConflictException` instead of silently disambiguating.
- Prisma errors are translated to Nest HTTP exceptions manually by checking `PrismaClientKnownRequestError` codes (`P2002` → `ConflictException`, `P2025` → `NotFoundException`), imported from `@prisma/client/runtime/client`.
- Products use soft delete (`deletedAt` field set on `removeProduct`, not an actual row delete); nothing currently filters `deletedAt` out of `findAll`/`findOneById`/`findOneBySlug`, so keep that in mind if querying reintroduces "deleted" products.
- `id`s are UUIDv7 (`@default(uuid(7))`) except `Tag.id`, which is UUIDv4 — the `:id` route in `ProductsController.findOneById` distinguishes UUID vs slug lookups using a UUIDv7-specific regex.
- Logging uses `nestjs-pino` (`src/common/logger/logger.module.ts`), pretty-printed outside production; note `app.useLogger(app.get(Logger))` is currently commented out in `main.ts`.
- Swagger/OpenAPI docs are served at `/api` (see `main.ts`).
- `CategoriesService`/`CategoriesController` and the `users` module are currently stubs/skeletons compared to `products` — don't assume they follow the same maturity level when reading them for patterns.
