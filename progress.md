Original prompt: 恩，统一用CCC把它做完

Progress:
- Added a CCC shell deployment script for the CKB contract cell.
- Added package scripts for dry-run and real deployment.
- Documented the Vercel root directory and environment flow.
- Verified `pnpm deploy:contract:dry-run` and `pnpm build`.
- Updated `.env.example` to match the current contract binary code hash.

TODO:
- Run `CKB_PRIVATE_KEY=0x... pnpm deploy:contract` from `frontend/` with a funded testnet key.
- Paste the printed `NEXT_PUBLIC_*` values into Vercel.
