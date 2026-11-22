Tiny real .rar sets for the unpacking tests and the Docker smoke test, made by
`test/fakes/rar.ts` (our own writer; `test/unpack.test.ts` checks these files
still match it). Each holds `Movie.2024.1080p.BluRay.x264-GRP.mkv`, whose bytes
are `FIXTURE_VIDEO`.

- `split.part1.rar`, `split.part2.rar`: RAR5, split in two, named the new way.
- `old.rar`, `old.r00`: RAR 4, split in two, named the old way.
