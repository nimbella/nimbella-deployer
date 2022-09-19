/*
 * Copyright (c) 2022 - present DigitalOcean, LLC
 *
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// Includes support for listing, installing, and removing triggers in the scheduling server, when such
// triggers are attached to an action.  Currently, only sourceType=scheduler is supported for triggers.
// Others will be rejected.  Eventually, this can be replaced by a dispatching discipline of some sort
// that looks at the sourceType and calls specialized code for that source type.

// TEMPORARY: some of this code is invoking actions in /nimbella/triggers/[create|delete|list] rather than
// APIs more closely associated with the scheduling service.  Right now, there is dual behavior depending
// on the environment variables TRIGGER_API_ENDPOINT and TRIGGER_API_TOKEN.  If both are non-blank, they
// are used to contact the "real" endpoint.  Otherwise, the temporary actions are contacted.
// The need for TRIGGER_API_TOKEN is not actually temporary: the deployer needs to get this information
// somehow even when the dual mode behavior is retired.

import openwhisk from 'openwhisk'
import { TriggerSpec, SchedulerSourceDetails } from './deploy-struct'
import axios from 'axios'
import makeDebug from 'debug'
const debug = makeDebug('nim:deployer:triggers')
const TRIGGER_API_ENDPOINT=process.env.TRIGGER_API_ENDPOINT
const TRIGGER_API_TOKEN=process.env.DO_API_KEY

export async function deployTriggers(triggers: TriggerSpec[], functionName: string, wsk: openwhisk.Client,
    namespace: string): Promise<object[]> {
  const promises: Promise<object>[] = []
  for (const trigger of triggers) {
    promises.push(deployTrigger(trigger, functionName, wsk, namespace))   
  }
  return Promise.all(promises)
}

export async function undeployTriggers(triggers: string[], wsk: openwhisk.Client, namespace: string): Promise<void> {
  for (const trigger of triggers) {
    await undeployTrigger(trigger, wsk, namespace)
  }
}

// Code to deploy a trigger.  Uses the prototype API unless TRIGGER_API_ENDPOINT
//   and TRIGGER_API_TOKEN are set.
// Note that basic structural validation of each trigger has been done previously
// so paranoid checking is omitted.
async function deployTrigger(trigger: TriggerSpec, functionName: string, wsk: openwhisk.Client, namespace: string): Promise<object> {
  const details = trigger.sourceDetails as SchedulerSourceDetails
  const { cron, withBody } = details
  const { sourceType, enabled } = trigger
  const params = {
    triggerName: trigger.name,
    function: functionName,
    sourceType,
    cron,
    withBody,
    overwrite: true,
    enabled
  }
  if (TRIGGER_API_ENDPOINT && TRIGGER_API_TOKEN) {
      return doTriggerCreate(trigger.name, functionName, namespace, cron)
  }
  return await wsk.actions.invoke({
    name: '/nimbella/triggers/create',
    params,
    blocking: true,
    result: true
  })
}

// Create a trigger using the real API
async function doTriggerCreate(trigger: string, fcn: string, namespace: string, cron: string): Promise<object> {
  const config = {
    url: TRIGGER_API_ENDPOINT + '/v2/functions/trigger',
    method: 'post',
    data: {
      name: trigger,
      namespace,
      function: fcn,
      trigger_source: 'SCHEDULED',
      cron
    }
  }
  return doAxios(config)
}

// Perform a network operation with axios, given a config object.
async function doAxios(config: any): Promise<object> {
  const response = await axios(config)
  return response.data
}

// Code to delete a trigger.  Uses the prototype API unless TRIGGER_API_ENDPOINT
//   and TRIGGER_API_TOKEN are set.
async function undeployTrigger(trigger: string, wsk: openwhisk.Client, namespace: string) {
  debug('undeploying trigger %s', trigger)
  if (TRIGGER_API_ENDPOINT && TRIGGER_API_TOKEN) {
      return doTriggerDelete(trigger, namespace)
  }
  const params = {
    triggerName: trigger
  }
  return await wsk.actions.invoke({
    name: '/nimbella/triggers/delete',
    params,
    blocking: true,
    result: true
  })
}

// Delete a trigger using the real API
async function doTriggerDelete(trigger: string, namespace: string): Promise<object> {
  const config = {
    url: TRIGGER_API_ENDPOINT + `/v2/functions/trigger/${namespace}/${trigger}`,
    method: 'delete',
  }
  return doAxios(config)
}

// Code to get all the triggers for a namespace, or all the triggers for a function in the
// namespace.  Uses the prototype API unless TRIGGER_API_ENDPOINT and TRIGGER_API_TOKEN are set.
export async function listTriggersForNamespace(wsk: openwhisk.Client, namespace: string, fcn?: string): Promise<string[]> {
  debug('listing triggers')
  if (TRIGGER_API_ENDPOINT && TRIGGER_API_TOKEN) {
    return doTriggerList(namespace, fcn)
  }
  const params: any = {
    name: '/nimbella/triggers/list',
    blocking: true,
    result: true
  }
  if (fcn) {
    params.params = { function: fcn }
  }
  const triggers: any = await wsk.actions.invoke(params)
  debug('triggers listed')
  return triggers.items.map((trigger: any) => trigger.triggerName)
}

// List triggers using the real API
// TODO There are too many open questions on the real API concerning what information
// will be returned.  So this is a "not implemented" for the moment.
async function doTriggerList(namespace: string, fcn: string): Promise<string[]> {
  throw new Error('Listing triggers, hence cleaning up triggers, is not yet implemented')
}
