import { Phase1Staking } from "@babylonlabs-io/btc-staking-ts";
import { Transaction, networks } from "bitcoinjs-lib";

import { signPsbtTransaction } from "@/app/common/utils/psbt";
import { GlobalParamsVersion } from "@/app/types/globalParams";
import { UTXO, WalletProvider } from "@/utils/wallet/wallet_provider";

import { txFeeSafetyCheck } from "./fee";

// Returns:
// - unsignedStakingPsbt: the unsigned staking transaction
// - stakingTerm: the staking term
// - stakingFee: the staking fee
export const createStakingTx = (
  globalParamsVersion: GlobalParamsVersion,
  stakingAmountSat: number,
  stakingTimeBlocks: number,
  finalityProviderPublicKey: string,
  btcWalletNetwork: networks.Network,
  address: string,
  publicKeyNoCoord: string,
  feeRate: number,
  inputUTXOs: UTXO[],
) => {
  const phase1Staking = new Phase1Staking(btcWalletNetwork, {
    address,
    publicKeyHex: publicKeyNoCoord,
  });

  const { psbt, fee } = phase1Staking.createStakingTransaction(
    globalParamsVersion,
    stakingAmountSat,
    stakingTimeBlocks,
    finalityProviderPublicKey,
    inputUTXOs,
    feeRate,
  );
  return { unsignedStakingPsbt: psbt, stakingFeeSat: fee };
};

// Sign a staking transaction
// Returns:
// - stakingTxHex: the signed staking transaction
// - stakingTerm: the staking term
export const signStakingTx = async (
  btcWallet: WalletProvider,
  globalParamsVersion: GlobalParamsVersion,
  stakingAmountSat: number,
  stakingTimeBlocks: number,
  finalityProviderPublicKey: string,
  btcWalletNetwork: networks.Network,
  address: string,
  publicKeyNoCoord: string,
  feeRate: number,
  inputUTXOs: UTXO[],
): Promise<{ stakingTxHex: string }> => {
  // Create the staking transaction
  let { unsignedStakingPsbt, stakingFeeSat } = createStakingTx(
    globalParamsVersion,
    stakingAmountSat,
    stakingTimeBlocks,
    finalityProviderPublicKey,
    btcWalletNetwork,
    address,
    publicKeyNoCoord,
    feeRate,
    inputUTXOs,
  );

  // Sign the staking transaction
  let stakingTx: Transaction;
  try {
    stakingTx = await signPsbtTransaction(btcWallet)(
      unsignedStakingPsbt.toHex(),
    );
  } catch (error: Error | any) {
    throw new Error(error?.message || "Staking transaction signing PSBT error");
  }

  // Get the staking transaction hex
  const stakingTxHex = stakingTx.toHex();

  txFeeSafetyCheck(stakingTx, feeRate, stakingFeeSat);

  // Broadcast the staking transaction
  await btcWallet.pushTx(stakingTxHex);

  return { stakingTxHex };
};
