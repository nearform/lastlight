# daterange

A tiny inclusive date-range utility.

- `inclusiveDayCount(start, end)` — number of whole days in the inclusive range.
- `eachDay(start, end)` — every `YYYY-MM-DD` in the inclusive range.

## Development

```bash
npm test      # node --test (TS via --experimental-strip-types)
npm run lint  # dependency-free house-rule checks over src/
npm run check # lint + test (also run in CI — see .github/workflows/ci.yml)
```
