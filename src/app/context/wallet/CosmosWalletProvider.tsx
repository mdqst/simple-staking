import { BroadcastMode } from "@keplr-wallet/types";
import { CosmosProvider } from "@tomo-inc/tomo-wallet-provider";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { useError } from "@/app/context/Error/ErrorContext";
import { ErrorState } from "@/app/types/errors";

import { useWalletConnection } from "./WalletConnectionProvider";

interface CosmosWalletContextProps {
  bech32Address: string;
  // pubKey: string;
  connected: boolean;
  disconnect: () => void;
  open: () => void;
  sendTx(tx: Uint8Array): Promise<void>;
}

const CosmosWalletContext = createContext<CosmosWalletContextProps>({
  bech32Address: "",
  // pubKey: "",
  connected: false,
  disconnect: () => {},
  open: () => {},
  sendTx: async () => {},
});

export const CosmosWalletProvider = ({ children }: PropsWithChildren) => {
  const [cosmosWalletProvider, setCosmosWalletProvider] =
    useState<CosmosProvider>();
  const [cosmosBech32Address, setCosmosBech32Address] = useState("");
  // const [cosmosPubKey, setCosmosPubKey] = useState("");
  // const [cosmosChainID, setCosmosChainID] = useState("");

  const { showError } = useError();
  const { open, isConnected, providers } = useWalletConnection();

  const cosmosDisconnect = useCallback(() => {
    setCosmosWalletProvider(undefined);
    setCosmosBech32Address("");
    // setCosmosPubKey("");
    // setCosmosChainID("");
  }, []);

  const connectCosmos = useCallback(async () => {
    if (!providers.cosmosProvider) return;

    try {
      // const chainID = providers.cosmosProvider.provider.getChainId();
      // const cosmosInfo =
      //   await providers.cosmosProvider.provider.getKey(chainID);
      await providers.cosmosProvider.connectWallet();
      const address = await providers.cosmosProvider.getAddress();
      // const { bech32Address, pubKey } = cosmosInfo;
      setCosmosWalletProvider(providers.cosmosProvider);
      setCosmosBech32Address(address);
      // setCosmosPubKey(Buffer.from(pubKey).toString("hex"));
      // setCosmosChainID(chainID);
    } catch (error: any) {
      showError({
        error: {
          message: error.message,
          errorState: ErrorState.WALLET,
        },
        retryAction: connectCosmos,
      });
    }
  }, [providers.cosmosProvider, showError]);

  const cosmosContextValue = useMemo(() => {
    if (!cosmosWalletProvider) {
      return {
        bech32Address: cosmosBech32Address,
        connected: false,
        disconnect: cosmosDisconnect,
        open,
        sendTx: async () => {},
      };
    }
    return {
      bech32Address: cosmosBech32Address,
      // pubKey: cosmosPubKey,
      connected: Boolean(cosmosWalletProvider),
      disconnect: cosmosDisconnect,
      open,
      async sendTx(tx: Uint8Array) {
        const result = await cosmosWalletProvider.sendTx(
          tx,
          "sync" as BroadcastMode,
        );
        // Decode the result
        const decodedResult = new TextDecoder().decode(result);

        // Try to parse the decoded result as JSON
        let jsonResult;
        try {
          jsonResult = JSON.parse(decodedResult);
        } catch (error) {
          throw new Error(`Failed to parse the result: ${decodedResult}`);
        }
        if (jsonResult.code !== undefined && jsonResult.code !== 0) {
          throw new Error(
            `Failed to send transaction: ${jsonResult.log || jsonResult.rawLog}`,
          );
        }
      },
    };
  }, [
    cosmosBech32Address,
    // cosmosPubKey,
    cosmosWalletProvider,
    cosmosDisconnect,
    open,
  ]);

  useEffect(() => {
    if (isConnected && providers.state) {
      if (!cosmosWalletProvider && providers.cosmosProvider) {
        connectCosmos();
      }
    }
  }, [
    connectCosmos,
    providers.cosmosProvider,
    providers.state,
    isConnected,
    cosmosWalletProvider,
  ]);

  // Clean up the state when isConnected becomes false
  useEffect(() => {
    if (!isConnected) {
      cosmosDisconnect();
    }
  }, [isConnected, cosmosDisconnect]);

  return (
    <CosmosWalletContext.Provider value={cosmosContextValue}>
      {children}
    </CosmosWalletContext.Provider>
  );
};

export const useCosmosWallet = () => useContext(CosmosWalletContext);
