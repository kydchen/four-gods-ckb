Original prompt: 恩，统一用CCC把它做完

Progress:
- Added a CCC shell deployment script for the CKB contract cell.
- Added package scripts for dry-run and real deployment.
- Documented the Vercel root directory and environment flow.
- Verified `pnpm deploy:contract:dry-run` and `pnpm build`.
- Updated `.env.example` to match the current contract binary code hash.
- Fixed lock-script game transitions and added a regression test for joining when the game contract is used as the cell lock.
- Verified `cargo test --package tests`, `pnpm build`, and `pnpm deploy:contract:dry-run`.
- Reworked the frontend into a playable table UI with Game ID sharing, phase guidance, player seats, transaction log, and start-button gating until the 2-player minimum is met.
- Restored Tailwind loading by importing `globals.css` from the root layout.
- Verified `pnpm build`, desktop Playwright smoke test, and 390px mobile viewport smoke test.
- Reworked the game model to adaptive 2-6 seats: rooms are max 6 by default, creator auto-sits, players can join active games as pending, and pending players enter on the next round.
- Added `active_from_round` to the contract/player serialization and a regression test for a late joiner entering round 2.
- Replaced the form-style UI with a 3D lobby/table scene, chain-scanned challenge hall, room cards, and active/pending seat states.
- Verified `make build`, `cargo test --package tests`, `pnpm build`, Playwright 3D lobby smoke test, and 390px mobile viewport smoke test.

TODO:
- Deploy the new contract binary; latest dry-run code hash is `0x23103975eab89b45df14736d00d42c0995b9a5f04700080c3daf885ebcf88fbd`.
- Update Vercel env with the new deploy tx hash/index and redeploy from `main`.
