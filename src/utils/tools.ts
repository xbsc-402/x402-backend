export const BSC_RPC_LIST = [
    'https://rpc.ankr.com/bsc',
    'https://bsc.drpc.org',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed2.defibit.io',
    'https://bsc-dataseed3.defibit.io',
    'https://bsc-dataseed4.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
    'https://bsc-dataseed2.ninicoin.io',
    'https://bsc-dataseed3.ninicoin.io',
    'https://bsc-dataseed4.ninicoin.io',
    'https://bsc.rpc.blxrbdn.com',
    'https://1rpc.io/bnb',
    'https://binance.nodereal.io',
    'https://bsc-mainnet.public.blastapi.io',
    'https://bsc.publicnode.com',
    'https://bsc.meowrpc.com',
    'https://bsc-pokt.nodies.app',
    'https://rpc-bsc.48.club',
  'https://lb.drpc.live/bsc/AoblK20ilErNoa-Q4ia8Ehv3qC6ArHQR8LlCQrxF2MGT',
  ];

export function getRandomBscRpc() {
  return BSC_RPC_LIST[Math.floor(Math.random() * BSC_RPC_LIST.length)];
}