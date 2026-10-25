/*
 * SPDX-License-Identifier: Apache-2.0
 */
import { type Contract } from 'fabric-contract-api';
import { AnchorContract } from './anchor';

export { AnchorContract } from './anchor';

export const contracts: (typeof Contract)[] = [AnchorContract];
