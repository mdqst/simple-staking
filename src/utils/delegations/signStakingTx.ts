import { stakingTransaction } from "@babylonlabs-io/btc-staking-ts";
import { Psbt, Transaction, networks } from "bitcoinjs-lib";

import { GlobalParamsVersion } from "@/app/types/globalParams";
import { apiDataToStakingScripts } from "@/utils/apiDataToStakingScripts";
import { isTaproot } from "@/utils/wallet";
import { UTXO } from "@/utils/wallet/btc_wallet_provider";

import { getStakingTerm } from "../getStakingTerm";

import { txFeeSafetyCheck } from "./fee";
import { paramsMock } from "./paramsMock";
import { createBtcDelegation } from "./staking";

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
  // Get the staking term, it will ignore the `stakingTimeBlocks` and use the value from params
  // if the min and max staking time blocks are the same
  const stakingTerm = getStakingTerm(globalParamsVersion, stakingTimeBlocks);

  // Check the staking data
  if (
    stakingAmountSat < globalParamsVersion.minStakingAmountSat ||
    stakingAmountSat > globalParamsVersion.maxStakingAmountSat ||
    stakingTerm < globalParamsVersion.minStakingTimeBlocks ||
    stakingTerm > globalParamsVersion.maxStakingTimeBlocks
  ) {
    throw new Error("Invalid staking data");
  }

  if (inputUTXOs.length == 0) {
    throw new Error("Not enough usable balance");
  }

  if (feeRate <= 0) {
    throw new Error("Invalid fee rate");
  }

  // Create the staking scripts
  let scripts;
  try {
    scripts = apiDataToStakingScripts(
      finalityProviderPublicKey,
      stakingTerm,
      globalParamsVersion,
      publicKeyNoCoord,
    );
  } catch (error: Error | any) {
    throw new Error(error?.message || "Cannot build staking scripts");
  }

  // Create the staking transaction
  let unsignedStakingPsbt;
  let stakingFeeSat;
  try {
    const { psbt, fee } = stakingTransaction(
      scripts,
      stakingAmountSat,
      address,
      inputUTXOs,
      btcWalletNetwork,
      feeRate,
      isTaproot(address) ? Buffer.from(publicKeyNoCoord, "hex") : undefined,
      // `lockHeight` is exclusive of the provided value.
      // For example, if a Bitcoin height of X is provided,
      // the transaction will be included starting from height X+1.
      // https://learnmeabitcoin.com/technical/transaction/locktime/
      globalParamsVersion.activationHeight - 1,
    );
    unsignedStakingPsbt = psbt;
    stakingFeeSat = fee;
  } catch (error: Error | any) {
    throw new Error(
      error?.message || "Cannot build unsigned staking transaction",
    );
  }

  return { unsignedStakingPsbt, stakingTerm, stakingFeeSat };
};

// Sign a staking transaction
// Returns:
// - stakingTxHex: the signed staking transaction
// - stakingTerm: the staking term
export const signStakingTx = async (
  signMessageBIP322: (message: string) => Promise<string>,
  signPsbt: (psbtHex: string) => Promise<string>,
  sendBbnTx: (tx: Uint8Array) => Promise<void>,
  bech32Address: string,
  pushTx: any,
  globalParamsVersion: GlobalParamsVersion,
  stakingAmountSat: number,
  stakingTimeBlocks: number,
  finalityProviderPublicKey: string,
  btcWalletNetwork: networks.Network,
  address: string,
  publicKeyNoCoord: string,
  feeRate: number,
  inputUTXOs: UTXO[],
): Promise<{ stakingTxHex: string; stakingTerm: number }> => {
  // TODO: REMOVE THIS
  const btcInput = {
    btcNetwork: btcWalletNetwork,
    stakerInfo: {
      address: address,
      publicKeyNoCoordHex: publicKeyNoCoord,
    },
    stakerAddress: address,
    stakerNocoordPk: publicKeyNoCoord,
    finalityProviderPublicKey: finalityProviderPublicKey,
    stakingAmountSat: paramsMock.minStakingAmountSat,
    stakingTimeBlocks: paramsMock.minStakingTimeBlocks,
    inputUTXOs: inputUTXOs,
    feeRate: feeRate,
    params: paramsMock,
  };

  await createBtcDelegation(
    btcInput,
    { bech32Address },
    async (step, psbtHex) => {
      console.log(step);
      return await signPsbt(psbtHex);
    },
    async (step, message) => {
      console.log(step);
      return await signMessageBIP322(message);
    },
    async (step, tx) => {
      console.log(step);
      return await sendBbnTx(tx);
    },
  );

  // Create the staking transaction
  let { unsignedStakingPsbt, stakingTerm, stakingFeeSat } = createStakingTx(
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
    const signedStakingPsbtHex = await signPsbt(unsignedStakingPsbt.toHex());
    stakingTx = Psbt.fromHex(signedStakingPsbtHex).extractTransaction();
  } catch (error: Error | any) {
    throw new Error(error?.message || "Staking transaction signing PSBT error");
  }

  // Get the staking transaction hex
  const stakingTxHex = stakingTx.toHex();

  txFeeSafetyCheck(stakingTx, feeRate, stakingFeeSat);

  // Broadcast the staking transaction
  await pushTx(stakingTxHex);

  return { stakingTxHex, stakingTerm };
};
