/*
 * Copyright (c) 2019 - present Nimbella Corp.
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

import {
  DeployStructure, DeployResponse, ActionSpec, PackageSpec, WebResource, BucketSpec, VersionEntry,
  ProjectReader, OWOptions, KeyVal, Feedback
} from './deploy-struct'
import { StorageClient } from '@nimbella/storage'
import {
  combineResponses, wrapError, wrapSuccess, keyVal, emptyResponse, isTextType, getActionName,
  straysToResponse, wipe, makeDict, digestPackage, digestAction, loadVersions, waitForActivation,
  deleteAction
} from './util'
import openwhisk from 'openwhisk'
import { deployToBucket, cleanBucket } from './deploy-to-bucket'
import { ensureWebLocal, deployToWebLocal } from './web-local'
import { deployTriggers } from './triggers'
import rimrafOrig from 'rimraf'
import { promisify } from 'util'
import makeDebug from 'debug'

const debug = makeDebug('nim:deployer:deploy')
const seqDebug = makeDebug('nim:deployer:sequences')
const chunkDebug = makeDebug('nim:deployer:chunk')
const rimraf = promisify(rimrafOrig)

// Temp fix until https://github.com/apache/openwhisk-client-js/pull/225 is merged.
type Exec = openwhisk.Exec & { image?: string }

//
// Main deploy logic, excluding that assigned to more specialized files
//

// The max number of operations to have outstanding at a time (for actions and web resources).
// It isn't obvious how to tune this, but 25 seems to work reliably and 50 sometimes has
// failures.  I have had success with 40, actually, but don't want to push our luck.
const DEPLOYMENT_CHUNK_SIZE = parseInt(process.env.DEPLOYMENT_CHUNK_SIZE) || 25

// Clean resources as requested unless the 'incremental', 'include' or 'exclude' is specified.
// For 'incremental', cleaning is skipped entirely.  Otherwise, cleaning is skipped for portions of
// the project not included in the deployment.  Note: there should always be an Includer by the time we reach here.
export async function cleanOrLoadVersions(todeploy: DeployStructure): Promise<DeployStructure> {
  if (todeploy.flags.incremental) {
    // Incremental deployment requires the versions up front to have access to the form hashes
    todeploy.versions = loadVersions(todeploy.filePath, todeploy.credentials.namespace, todeploy.credentials.ow.apihost)
  } else {
    if (todeploy.includer.isWebIncluded && !todeploy.webBuildResult && (todeploy.cleanNamespace || (todeploy.bucket && todeploy.bucket.clean))) {
      if (todeploy.bucketClient) {
        const warn = await cleanBucket(todeploy.bucketClient, todeploy.bucket, todeploy.credentials.ow)
        if (warn) {
          todeploy.feedback.warn(warn)
        }
      } else if (todeploy.flags.webLocal) {
        await rimraf(todeploy.flags.webLocal)
      }
    }
    if (todeploy.cleanNamespace && todeploy.includer.isIncludingEverything()) {
      await wipe(todeploy.owClient)
    } else {
      await cleanActionsAndPackages(todeploy)
    }
  }
  return Promise.resolve(todeploy)
}

// Do the actual deployment (after testing the target namespace and cleaning)
export async function doDeploy(todeploy: DeployStructure): Promise<DeployResponse> {
  let webLocal: string
  if (todeploy.flags.webLocal) {
    webLocal = ensureWebLocal(todeploy.flags.webLocal)
  }
  let webResults: DeployResponse[]
  const remoteResult = todeploy.webBuildResult
  if (remoteResult) {
    webResults = [await processRemoteResponse(remoteResult, todeploy.owClient, 'web content', todeploy.feedback)]
  } else if (todeploy.webBuildError) {
    webResults = [wrapError(todeploy.webBuildError, 'web content')]
  } else {
    webResults = await deployAllWebResources(todeploy, webLocal)
  }
  const skipPkgDeploy = todeploy.slice && todeploy.deployerAnnotation.newSliceHandling
  delete todeploy.deployerAnnotation.newSliceHandling
  const actionPromises = todeploy.packages.map(pkg => deployPackage(pkg, todeploy, skipPkgDeploy))
  const responses: DeployResponse[] = webResults.concat(await Promise.all(actionPromises))
  responses.push(straysToResponse(todeploy.strays))
  const sequenceResponses = await deploySequences(todeploy)
  responses.push(...sequenceResponses)
  const response = combineResponses(responses)
  response.apihost = todeploy.credentials.ow.apihost
  if (!response.namespace) { response.namespace = todeploy.credentials.namespace }
  return response
}

// Deploy web resources, potentially in chunks to avoid overloading the storage server
async function deployAllWebResources(todeploy: DeployStructure, webLocal: string): Promise<DeployResponse[]> {
  let pending = todeploy.web
  const ans: DeployResponse[] = []
  while (pending.length > 0) {
    const chunk = pending.length > DEPLOYMENT_CHUNK_SIZE ? pending.slice(0, DEPLOYMENT_CHUNK_SIZE) : pending
    pending = pending.slice(chunk.length)
    const chunkResults = chunk.map(res => deployWebResource(res, todeploy.actionWrapPackage, todeploy.bucket,
      todeploy.bucketClient, todeploy.flags.incremental ? todeploy.versions : undefined, webLocal, todeploy.reader,
      todeploy.credentials.ow))
    ans.push(...await Promise.all(chunkResults))
  }
  return ans
}

// Process the remote result when something has been built remotely
async function processRemoteResponse(activationId: string, owClient: openwhisk.Client, context: string, feedback: Feedback): Promise<DeployResponse> {
  let activation: openwhisk.Activation<openwhisk.Dict>
  const tick = () => feedback.progress(`Processing of ${context} is still running remotely ...`)
  try {
    activation = await waitForActivation(activationId, owClient, tick, 15*60) // approx 15 minutes limit
  } catch (err) {
    return wrapError(err, context + ' (waiting for remote build response)')
  }
  if (!activation) {
    return wrapError(new Error('Build timed out'), ' (waiting for remote build response)')
  }
  if (!activation.response || !activation.response.success) {
    let err = 'Remote build failed to provide a result'
    const resultError = activation?.response?.result?.error
    if (resultError) {
      const errMsg = typeof resultError === 'string' ? resultError : resultError.message
      if (typeof errMsg === 'string') {
        const parts = errMsg.split("Error:")
        err = parts[parts.length - 1]
      }
    }
    const thrown = new Error(err) as any
    thrown.activation = JSON.stringify(activation, null, 2) // ensure deep enough nesting
    return wrapError(thrown, context + ' (running remote build)')
  }
  const result = activation.response.result as Record<string, any>
  debug('Remote result was %O', result)
  const { transcript, outcome } = result
  if (transcript && transcript.length > 0) {
    feedback.progress(`Transcript of remote build session for ${context}:`)
    for (const line of transcript) {
      feedback.progress(line)
    }
  }
  return outcome
}

// Look for 'clean' flags in the actions and packages and perform the cleaning.
function cleanActionsAndPackages(todeploy: DeployStructure): Promise<DeployStructure> {
  if (!todeploy.packages) {
    return Promise.resolve(todeploy)
  }
  const promises: Promise<any>[] = []
  for (const pkg of todeploy.packages) {
    const defaultPkg = pkg.name === 'default'
    if (pkg.clean && !defaultPkg && todeploy.includer.isPackageIncluded(pkg.name, true)) {
      // We should have headed off 'clean' of the default package already.  The added test is just in case
      promises.push(cleanPackage(todeploy.owClient, pkg.name, todeploy.versions))
    } else if (pkg.actions) {
      for (const action of pkg.actions) {
        if (action.clean && todeploy.includer.isActionIncluded(pkg.name, action.name) && !action.buildResult) {
          if (todeploy.versions && todeploy.versions.actionVersions) {
            delete todeploy.versions.actionVersions[action.name]
          }
          promises.push(deleteAction(getActionName(action), todeploy.owClient).catch(() => undefined))
        }
      }
    }
  }
  return Promise.all(promises).then(() => todeploy)
}

// Clean a package by first deleting its contents then deleting the package itself
// The 'versions' argument can be undefined, allowing this to be used to delete packages without a project context
export async function cleanPackage(client: openwhisk.Client, name: string, versions: VersionEntry): Promise<openwhisk.Package> {
  debug('Cleaning package %s', name)
  while (true) {
    const pkg = await client.packages.get({ name }).catch(() => undefined)
    if (!pkg) {
      return { name }
    }
    if (!pkg.actions || pkg.actions.length === 0) {
      debug('No more actions, removing package')
      if (versions && versions.packageVersions) { delete versions.packageVersions[name] }
      return client.packages.delete({ name })
    }
    for (const action of pkg.actions) {
      debug('deleting action %s', action.name)
      if (versions && versions.actionVersions) { delete versions.actionVersions[action.name] }
      await deleteAction(name + '/' + action.name, client)
    }
  }
}

// Deploy a web resource.  If this is invoked, we can assume that at least one of actionWrapPackage, bucketClient,
// or webLocal is defined.  If actionWrapPackage is provided, this step is a no-op since the actual action wrapping
// will have been done in the prepareToDeploy step and the fact of action wrapping will be part of the final status
// message for deploying the action.  If webLocal is specified, the deploy is just a copy to the specified location,
// which is assumed to exist (it should have been created already).  Otherwise, if bucketClient is specified, this
// is a traditional deploy to the bucket.  Otherwise (none specified) it is an error.
export function deployWebResource(res: WebResource, actionWrapPackage: string, spec: BucketSpec,
  bucketClient: StorageClient, versions: VersionEntry, webLocal: string, reader: ProjectReader, owOptions: OWOptions): Promise<DeployResponse> {
  // We can rely on the fact that prepareToDeploy would have rejected the deployment if action wrapping failed.
  if (actionWrapPackage) {
    return Promise.resolve(emptyResponse())
  } else if (webLocal) {
    return deployToWebLocal(res, webLocal, spec)
  } else if (bucketClient) {
    return deployToBucket(res, bucketClient, spec, versions, reader, owOptions)
  } else {
    return Promise.resolve(wrapError(new Error(`No bucket client and/or bucket spec for '${res.simpleName}'`), 'web resources'))
  }
}

// Wrap a web resource in an action.   Returns a promise of the resulting ActionSpec
export async function actionWrap(res: WebResource, reader: ProjectReader, pkgName: string): Promise<ActionSpec> {
  const body = (await reader.readFileContents(res.filePath)).toString('base64')
  const name = res.simpleName.endsWith('.html') ? res.simpleName.replace('.html', '') : res.simpleName
  let bodyExpr = `  const body = '${body}'`
  if (isTextType(res.mimeType)) {
    bodyExpr = "  const body = Buffer.from('" + body + "', 'base64').toString('utf-8')"
  }
  const code = `function main() {
    ${bodyExpr}
    return {
       statusCode: 200,
       headers: { 'Content-Type': '${res.mimeType}' },
       body
    }
}`
  return { name, file: res.filePath, runtime: 'nodejs:default', binary: false, web: true, code, wrapping: res.filePath, package: pkgName }
}

// Deploy an array of actions of arbitrary size, ensuring that most CHUNK_SIZE operations
// are pending at the same time. 
async function deployActionArray(actions: ActionSpec[], spec: DeployStructure,
    cleanFlag: boolean): Promise<DeployResponse> {
  let pending = actions
  const responses: DeployResponse[] = []  
  while (pending.length > 0) {
    const chunk = pending.length > DEPLOYMENT_CHUNK_SIZE ? pending.slice(0, DEPLOYMENT_CHUNK_SIZE) : pending
    pending = pending.slice(chunk.length)
    const chunkResults = await Promise.all(chunk.map(action => deployAction(action, spec, cleanFlag))).then(combineResponses)
    responses.push(chunkResults)
    chunkDebug('Deployed chunk of %d actions', chunk.length)
  }
  return combineResponses(responses)
}

// Subroutine to deploy just a package and not its actions.  Should only be called for
// "deployable" packages (not the default package) and only when deployment of the package
// is appropriate (not if the package has already been deployed or the context is a slice deploy).
export async function onlyDeployPackage(pkg: PackageSpec, spec: DeployStructure): Promise<DeployResponse> {
  const {
    parameters: projectParams, environment: projectEnv, cleanNamespace: namespaceIsClean, versions,
    owClient: wsk, deployerAnnotation: deployer, flags
  } = spec
  // Check whether the package metadata needs to be deployed; if so, deploy it.  If not, make a vacuous response with the existing package
  // VersionInfo.   That is needed so that the new versions.json will have the information in it.
  const digest = digestPackage(pkg)
  if (flags.incremental && versions.packageVersions && versions.packageVersions[pkg.name] && digest === versions.packageVersions[pkg.name].digest) {
    const packageVersions = {}
    packageVersions[pkg.name] = versions.packageVersions[pkg.name]
    return { successes: [], failures: [], ignored: [], packageVersions, actionVersions: {}, namespace: undefined }
  } else {
    let former: openwhisk.Package
    if (!pkg.clean && !namespaceIsClean) {
      former = await wsk.packages.get({ name: pkg.name }).catch(() => undefined)
    }
    const oldAnnots = former && former.annotations ? makeDict(former.annotations) : {}
    delete oldAnnots.deployerAnnot // remove unwanted legacy from undetected earlier error
    deployer.digest = digest.substring(0, 8)
    const annotDict = Object.assign({}, oldAnnots, pkg.annotations, { deployer })
    const annotations = keyVal(annotDict)
    const mergedParams = Object.assign({}, projectParams, pkg.parameters)
    const mergedEnv = Object.assign({}, projectEnv, pkg.environment)
    const params = encodeParameters(mergedParams, mergedEnv)
    const owPkg: openwhisk.Package = { parameters: params, annotations, publish: pkg.shared }
    return await wsk.packages.update({ name: pkg.name, package: owPkg }).then(result => {
      const packageVersions = {}
      packageVersions[pkg.name] = { version: result.version, digest }
      return { successes: [], failures: [], ignored: [], packageVersions, actionVersions: {}, namespace: result.namespace }
    }).catch(err => {
      return wrapError(err, `package '${pkg.name}'`)
    })
  }
}

// Deploy a package, then deploy everything in it (currently just actions)
export async function deployPackage(pkg: PackageSpec, spec: DeployStructure, skipPkgDeploy: boolean): Promise<DeployResponse> {
  const {
    parameters: projectParams, environment: projectEnv, cleanNamespace: namespaceIsClean
  } = spec
  if (pkg.name === 'default' && isAtLeastOneNonEmpty([projectParams, projectEnv, 
      pkg.parameters, pkg.environment, pkg.annotations])) {
      return wrapError(new Error('The default package does not support attaching environment or parameters'), `package 'default'`)
  }
  if (pkg.name === 'default' || skipPkgDeploy || pkg.deployedDuringBuild) {
    return deployActionArray(pkg.actions, spec, namespaceIsClean)
  }
  const pkgResponse = await onlyDeployPackage(pkg, spec)
  // Now deploy (or skip) the actions of the package
  const actionPromise = await deployActionArray(pkg.actions, spec, pkg.clean || namespaceIsClean)
  return combineResponses([actionPromise, pkgResponse])
}

// Test whether any object in an array of objects is non-empty.  Used here to check for illegal attachment of
// parameters or environment to the 'default' package, which doesn't really exist.
function isAtLeastOneNonEmpty(toCheck: object[]): boolean {
  for (const source of toCheck) {
    if (source && Object.keys(source).length > 0) {
      return true
    }
  }
  return false
}

// Deploy an action
function deployAction(action: ActionSpec, spec: DeployStructure, pkgIsClean: boolean): Promise<DeployResponse> {
  const { owClient: wsk, feedback, reader } = spec
  const context = `action '${getActionName(action)}'`
  debug('deploying %s', context)
  if (action.buildError) {
    return Promise.resolve(wrapError(action.buildError, context))
  }
  if (action.buildResult) {
    return processRemoteResponse(action.buildResult, wsk, context, feedback)
  }
  if (action.code) {
    debug('action already has code')
    return deployActionFromCodeOrSequence(action, spec, action.code, undefined, pkgIsClean)
  }
  if (action.sequence) {
    const error = checkForLegalSequence(action)
    if (error) {
      return Promise.resolve(wrapError(error, context))
    }
    if (!spec.sequences) {
      spec.sequences = []
    }
    spec.sequences.push(action)
    return Promise.resolve(emptyResponse())
  }
  const codeFile = action.file
  if (codeFile) {
    debug('reading action code from %s', codeFile)
    return reader.readFileContents(codeFile).then(data => {
      const code = action.binary ? data.toString('base64') : String(data)
      return code
    }).then((code: string) => deployActionFromCodeOrSequence(action, spec, code, undefined, pkgIsClean))
      .catch(err => Promise.resolve(wrapError(err, context)))
  } else {
    return Promise.resolve(wrapError(new Error('Action is named in the config but does not exist in the project'), context))
  }
}

// The ActionSpec is known to include the sequence member but may still not be consistent
function checkForLegalSequence(action: ActionSpec): any {
  if (action.file) {
    return new Error('An action cannot be a sequence and also exist in the project directory structure')
  }
  if (action.runtime || action.binary || action.main) {
    return new Error('An action cannot be a sequence and also have the runtime, binary, or main attributes')
  }
  return false
}

// Order the sequences of this deployment so that ones that depend on others come later in the order.
// Throw on cycle.
function sortSequences(sequences: ActionSpec[], spec: DeployStructure): ActionSpec[] {
  const { credentials: { namespace } } = spec
  const actionNames = getAllActionFqns(spec, namespace)
  const inProgress = new Set<string>()
  const completed = new Set<string>()
  const result: ActionSpec[] = []
  for (const seq of sequences) {
    if (!addSequenceToList(seq, namespace, result, inProgress, completed, sequences, actionNames, spec.feedback)) {
      // Cycle detected
      throw new Error('A cycle was detected in mutually dependent sequences')
    }
  }
  return result
}

// Recursive subroutine of sortSequences to check and position an individual sequence so as to follow its dependencies.
// To accomplish the goal, the dependencies are added first in the order found, and a "completed" set is used to prevent
// duplicates.
function addSequenceToList(seq: ActionSpec, namespace: string, result: ActionSpec[], inProgress: Set<string>, completed: Set<string>,
  sequences: ActionSpec[], actionNames: Set<string>, feedback: Feedback): boolean {
  const seqName = fqnFromActionSpec(seq, namespace)
  seqDebug('addSequenceToList %s', seqName)
  if (inProgress.has(seqName)) {
    seqDebug('found in inProgress')
    return false
  }
  if (completed.has(seqName)) {
    seqDebug('found in completed')
    return true
  }
  inProgress.add(seqName)
  const thisNsPrefix = '/' + namespace + '/'
  for (const member of seq.sequence) {
    const memberName = fqn(member, namespace)
    const preReq = sequences.find(cand => memberName === fqnFromActionSpec(cand, namespace))
    if (preReq) {
      seqDebug('Found pre-requisite sequence %s', preReq.name)
      if (!addSequenceToList(preReq, namespace, result, inProgress, completed, sequences, actionNames, feedback)) {
        return false
      }
    }
    if (memberName.startsWith(thisNsPrefix) && !actionNames.has(memberName)) {
      feedback.warn('Sequence \'%s\' contains action \'%s\' which is in the same namespace but not part of the deployment', seq.name, memberName)
    }
  }
  inProgress.delete(seqName)
  completed.add(seqName)
  seqDebug('adding %s to result', seqName)
  result.push(seq)
  return true
}

// Deploy the sequences of the project, if any.  These were identified while deploying the
// actions.  Sequence actions were lightly checked, then deferred.   Here, we sort the sequences
// so that dependent sequences are deployed before they are needed by other sequences.
// If that works (no cycles) then we deploy the result.
async function deploySequences(todeploy: DeployStructure): Promise<DeployResponse[]> {
  try {
    todeploy.sequences = sortSequences(todeploy.sequences || [], todeploy)
  } catch (err) {
    return [wrapError(err, 'sequences')]
  }
  const result: DeployResponse[] = []
  for (const seq of todeploy.sequences) {
    const components = seq.sequence.map(action => fqn(action, todeploy.credentials.namespace))
    const exec: openwhisk.Sequence = { kind: 'sequence', components }
    result.push(await deployActionFromCodeOrSequence(seq, todeploy, undefined, exec, isCleanPkg(todeploy, seq.package)))
  }
  return result
}

// Lookup a package in the DeployStructure and answer whether it is cleaned.  If the spec is cleaning
// the namespace that counts and we return true.
function isCleanPkg(spec: DeployStructure, pkgName: string): boolean {
  if (spec.cleanNamespace) {
    return true
  }
  const pkg = (spec.packages || []).find(pkg => pkg.name === pkgName)
  return !!pkg?.clean
}

// Compute a fully qualified OW name from an ActionSpec plus a default namespace
function fqnFromActionSpec(spec: ActionSpec, namespace: string): string {
  let name = spec.name
  if (spec.package && spec.package !== 'default') {
    name = `${spec.package}/${name}`
  }
  return `/${namespace}/${name}`
}

// Get the fqns of all actions in the spec
function getAllActionFqns(spec: DeployStructure, namespace: string): Set<string> {
  const ans = new Set<string>()
  for (const pkg of spec.packages) {
    if (pkg.actions) {
      pkg.actions.forEach(action => ans.add(fqnFromActionSpec(action, namespace)))
    }
  }
  return ans
}

// Convert an OW resource name to fqn form (it may already be in that form)
function fqn(name: string, namespace: string): string {
  if (name.startsWith('/')) {
    return name
  }
  return `/${namespace}/${name}`
}

function encodeParameters(normalParms: openwhisk.Dict, envParms: openwhisk.Dict): KeyVal[] {
  let ans: KeyVal[] = []
  if (normalParms) {
    ans = keyVal(normalParms)
  }
  if (envParms) {
    const envs = keyVal(envParms)
    envs.forEach(env => {
      env.init = true
    })
    ans = ans.concat(envs)
  }
  return ans
}

// Construct the Action.Exec struct from the deployment configuration values.
export function calculateActionExec(action: ActionSpec, code: string): Exec {
  const main = action.main ? action.main : undefined // '' is falsey but won't be recognized as such by OW
  if (action.docker) {
    return { code, binary: action.binary, kind: 'blackbox', image: action.docker, main }
  }

  return { code, binary: action.binary, kind: action.runtime, main }
}

// Deploy an action when the code has already been read from a() file or constructed programmatically or when the
// action is a sequence (Sequence passed in lieu of code).
async function deployActionFromCodeOrSequence(action: ActionSpec, spec: DeployStructure,
  code: string, sequence: openwhisk.Sequence, pkgIsClean: boolean): Promise<DeployResponse> {
  const name = getActionName(action)
  const { versions, flags, deployerAnnotation, owClient: wsk } = spec
  const deployerAnnot = Object.assign({}, deployerAnnotation)

  debug('deploying %s using %s', name, !sequence ? 'code' : 'sequence info')
  if (code && !action.runtime) {
    return Promise.resolve(wrapError(new Error(`Action '${name}' not deployed: runtime type could not be determined`), `action ${name}`))
  }
  // Check whether the action needs to be deployed; if so, deploy it.  If not, make a vacuous response with the existing package
  // VersionInfo.   That is needed so that the new versions.json will have the information in it.  We don't digest
  // or skip deployment for sequences.
  let digest: string
  if (!sequence) { // test for absence of sequence, not presence of code; code may be the empty string
    digest = digestAction(action, code)
    debug('computed digest for %s', name)
    if (flags.incremental && versions.actionVersions && versions.actionVersions[name] &&
      digest === versions.actionVersions[name].digest) {
      // Skipping deployment
      debug('matched digest for %s', name)
      const actionVersions = {}
      actionVersions[name] = versions.actionVersions[name]
      return Promise.resolve(wrapSuccess(name, 'action', true, undefined, actionVersions, undefined))
    }
    // Record
    debug('recording digest for %s', name)
    deployerAnnot.digest = digest.substring(0, 8)
  }
  // Will be deployed
  // Compute the annotations that we will definitely be adding
  deployerAnnot.zipped = action.zipped
  const annotations = Object.assign({}, action.annotations) || {}
  annotations.deployer = deployerAnnot
  annotations.final = true
  
  if (action.web === true) {
    annotations['web-export'] = true
    annotations['raw-http'] = false
  } else if (action.web === 'raw') {
    annotations['web-export'] = true
    annotations['raw-http'] = true
  } else if (!action.web) {
    annotations['web-export'] = false
    annotations['raw-http'] = false
  }
  if (typeof action.webSecure === 'string') {
    annotations['require-whisk-auth'] = action.webSecure
  } else {
    // A value of true should already have been flagged at validation time.
    annotations['require-whisk-auth'] = false
  }
  // Get the former annotations of the action if any
  let former: openwhisk.Action
  if (!action.clean && !pkgIsClean) {
    const options = { name, code: false }
    former = await wsk.actions.get(options).catch(() => undefined)
  }
  const oldAnnots = former && former.annotations ? makeDict(former.annotations) : {}
  // Merge the annotations
  const annotDict = Object.assign({}, oldAnnots, annotations)
  // Compute the complete Action value for the call
  const params = encodeParameters(action.parameters, action.environment)
  const exec = sequence || calculateActionExec(action, code)
  const actionBody: openwhisk.Action = { annotations: keyVal(annotDict), parameters: params, exec: exec as Exec }
  if (action.limits) {
    actionBody.limits = action.limits
  }
  const deployParams = { name, action: actionBody }
  try {
    const response = await wsk.actions.update(deployParams)
    if (action.triggers) {
      await deployTriggers(action.triggers, name, wsk, spec.credentials.namespace)
    }
    const map = {}
    if (digest) {
      map[name] = { version: response.version, digest }
    }
    const namespace = response.namespace.split('/')[0]
    return Promise.resolve(wrapSuccess(name, 'action', false, action.wrapping, map, namespace))
  } catch(err) {
    // TODO if the failure was in the trigger install, should the function be left in place?
    // Note that, in general, the deployer does not provide atomicity guarantees.  It can easily
    // end up doing partial deploys in other ways.
    return Promise.resolve(wrapError(err, `action '${name}'`))
  }
}
