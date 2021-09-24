import Schema, { TxIn, TxOut } from '@cardano-ogmios/schema';
import { UtxoRepository } from './UtxoRepository';
import { CardanoProvider, Ogmios } from '@cardano-sdk/core';
import { dummyLogger, Logger } from 'ts-log';
import { InputSelector, SelectionConstraints, SelectionResult } from '@cardano-sdk/cip2';
import { CardanoSerializationLib, CSL } from '@cardano-sdk/cardano-serialization-lib';
import { KeyManager } from './KeyManagement';

export class InMemoryUtxoRepository implements UtxoRepository {
  #csl: CardanoSerializationLib;
  #delegationAndRewards: Schema.DelegationsAndRewards;
  #inputSelector: InputSelector;
  #keyManager: KeyManager;
  #logger: Logger;
  #provider: CardanoProvider;
  #utxoSet: Set<[TxIn, TxOut]>;

  constructor(
    csl: CardanoSerializationLib,
    provider: CardanoProvider,
    keyManager: KeyManager,
    inputSelector: InputSelector,
    logger?: Logger
  ) {
    this.#csl = csl;
    this.#logger = logger ?? dummyLogger;
    this.#provider = provider;
    this.#utxoSet = new Set();
    this.#delegationAndRewards = { rewards: null, delegate: null };
    this.#inputSelector = inputSelector;
    this.#keyManager = keyManager;
  }

  public async sync(): Promise<void> {
    this.#logger.debug('Syncing InMemoryUtxoRepository');
    const result = await this.#provider.utxoDelegationAndRewards(
      [this.#keyManager.deriveAddress(1, 0)],
      Buffer.from(this.#keyManager.stakeKey.hash().to_bytes()).toString('hex')
    );
    this.#logger.trace(result);
    for (const utxo of result.utxo) {
      if (!this.#utxoSet.has(utxo)) {
        this.#utxoSet.add(utxo);
        this.#logger.debug('New UTxO', utxo);
      }
    }
    if (this.#delegationAndRewards.delegate !== result.delegationAndRewards.delegate) {
      this.#delegationAndRewards.delegate = result.delegationAndRewards.delegate;
      this.#logger.debug('Delegation stored', result.delegationAndRewards.delegate);
    }
    if (this.#delegationAndRewards.rewards !== result.delegationAndRewards.rewards) {
      this.#delegationAndRewards.rewards = result.delegationAndRewards.rewards;
      this.#logger.debug('Rewards balance stored', result.delegationAndRewards.rewards);
    }
  }

  public async selectInputs(
    outputs: CSL.TransactionOutputs,
    constraints: SelectionConstraints
  ): Promise<SelectionResult> {
    if (this.#utxoSet.size === 0) {
      this.#logger.debug('Local UTxO set is empty. Syncing...');
      await this.sync();
    }
    return this.#inputSelector.select({
      utxo: Ogmios.ogmiosToCsl(this.#csl).utxo([...this.#utxoSet.values()]),
      outputs,
      constraints
    });
  }

  public get allUtxos(): Schema.Utxo {
    return [...this.#utxoSet.values()];
  }

  public get rewards(): Schema.Lovelace {
    return this.#delegationAndRewards.rewards;
  }

  public get delegation(): Schema.PoolId {
    return this.#delegationAndRewards.delegate;
  }
}
