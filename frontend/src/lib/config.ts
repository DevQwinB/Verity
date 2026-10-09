// 127.0.0.1, not "localhost" - this host resolves localhost to ::1 first,
// and the backend only binds IPv4, so "localhost" fails fast with ECONNREFUSED.
export const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:3001";
export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
export const TESTNET_EXPLORER_TX = (hash: string) =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const TESTNET_EXPLORER_ACCOUNT = (account: string) =>
  `https://stellar.expert/explorer/testnet/account/${account}`;
export const TESTNET_EXPLORER_CONTRACT = (id: string) =>
  `https://stellar.expert/explorer/testnet/contract/${id}`;
/** How long a server-side call to the backend may take before the page gives
 * up and shows its error state. Transaction relays wait for confirmation
 * on-chain (up to ~45s in the backend), so actions get longer than reads. */
export const BACKEND_READ_TIMEOUT_MS = 20_000;
export const BACKEND_ACTION_TIMEOUT_MS = 90_000;
export const FREIGHTER_INSTALL_URL = "https://www.freighter.app/";
/** Testnet faucet. Server-side only: /api/friendbot calls it for the
 * signed-in account. */
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
