/**
 * Shared SQL fragments (decorator-free so the corpus test can import them).
 *
 * Custom-event payloads are stored as JSON text in `visitor_event.meta`; the
 * read side pulls single numeric keys out with SUBSTRING_INDEX rather than a
 * JSON function so the same statement runs on MariaDB, MySQL and Postgres.
 */

/** The raw token after `"productId":` — up to the next `,` or `}`, so both
 *  `{"productId":42,"x":1}` and `{"x":1,"productId":42}` yield `42`. */
export const PRODUCT_ID_TOKEN =
    `SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"productId":', -1), ',', 1), '}', 1)`;

/** Two-level variant for use inside GROUP_CONCAT (the dialect adapter's GROUP_CONCAT
 *  rewrite tolerates two nested parens); a trailing `}` is stripped by the caller. */
export const PRODUCT_ID_TOKEN_LOOSE =
    `SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"productId":', -1), ',', 1)`;

/** `ON CONFLICT` target for the TypeORM-created `product_co_view` table: its columns are
 *  quoted camelCase on Postgres, so the target must be quoted too (raw-DDL tables such as
 *  `abandoned_cart_opt_out` are lowercase there and must NOT be). Ignored on MySQL. */
export const PRODUCT_CO_VIEW_CONFLICT = ['"productIdA"', '"productIdB"', '"channelId"'];

/** Same for `"resultsCount":` on search events. */
export const RESULTS_COUNT_TOKEN =
    `SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(meta, '"resultsCount":', -1), ',', 1), '}', 1)`;

/** A predicate that is true only when `expr` is a run of digits. `CAST(x AS UNSIGNED)`
 *  is lenient on MySQL (`'42}'` → 42, `'abc'` → 0) but raises on Postgres, so the cast is
 *  always guarded by this. Regex syntax is the one construct the dialect adapter does
 *  not translate, hence the explicit switch. */
export function digitsOnly(dialect: 'mysql' | 'postgres', expr: string): string {
    return dialect === 'postgres' ? `${expr} ~ '^[0-9]+$'` : `${expr} REGEXP '^[0-9]+$'`;
}
