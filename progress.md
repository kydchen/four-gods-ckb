Original prompt: 恩，统一用CCC把它做完

Progress:
- Added a CCC shell deployment script for the CKB contract cell.
- Added package scripts for dry-run and real deployment.
- Documented the Vercel root directory and environment flow.
- Verified `pnpm deploy:contract:dry-run` and `pnpm build`.
- Updated `.env.example` to match the current contract binary code hash.
- Fixed lock-script game transitions and added a regression test for joining when the game contract is used as the cell lock.
- Verified `cargo test --package tests`, `pnpm build`, and `pnpm deploy:contract:dry-run`.

TODO:
- Redeploy the contract after the lock-script fix.
- Paste the new printed `NEXT_PUBLIC_*` values into Vercel.
