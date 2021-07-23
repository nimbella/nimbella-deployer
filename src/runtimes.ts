import axios, { AxiosInstance } from 'axios'
import { getCredentials, authPersister } from './credentials'

import debug from 'debug'
const debug_log = debug('nim:deployer:runtimes')

export const API_ENDPOINT = '/api/v1'

const RuntimesCache: Record<string, RuntimesConfig> = {}

// Custom types for runtimes.json configuration parameters
type RuntimeLabel = string
type RuntimeKind = string
type RuntimeFileExtension = string

export interface Runtime {
  kind: RuntimeKind
  default?: boolean
}

export type RuntimesConfig = Record<RuntimeLabel, Runtime[]>

// List of file extensions for runtimes. This hardcoded list used to be present
// in the extensions field of the runtimes.json document.
const FileExtensionRuntimes: Record<RuntimeKind, RuntimeFileExtension[]> = {
  'go': ['go'],
  'java': ['java', 'jar'],
  'nodejs': ['js'],
  'typescript': ['ts'],
  'php': ['php'],
  'python': ['py'],
  'ruby': ['rb'],
  'rust': ['rs'],
  'swift': ['swift'],
  'deno': ['ts', 'js'],
  'dotnet': ['cs', 'vb']
}

// File extensions which imply binary data
const BinaryFileExtensions: Set<RuntimeFileExtension> = new Set<RuntimeFileExtension>(['zip', 'jar'])

// Send HTTP request to platform endpoint for runtimes configuration
export async function fromPlatform(httpClient: AxiosInstance, platformUrl: string): Promise<Record<string, unknown>> {
  const url = `${platformUrl}${API_ENDPOINT}`
  debug_log(`loading runtimes from platform @ ${url}`)
  try {
    const { data } = await httpClient.get(url)
    debug_log(`loaded runtimes json: ${JSON.stringify(data)}`)
    return data?.runtimes
  } catch (err) {
    // Error due to HTTP Code > 2XX
    if (err.response) {
      throw new Error(`http request failed (${url}) with status (${err.response.status}): ${err.response.statusText} `)
      // or response never received
    } else if (err.request) {
      throw new Error(`http request failed: GET ${url}`)
      // or something else...
    } else {
      throw err
    }
  }
}

// Compute the runtime from the file extension.
export function runtimeForFileExtension(fileExtension: RuntimeFileExtension): RuntimeKind | undefined {
  const runtime = Object.entries(FileExtensionRuntimes).find((item, i) => item[1].includes(fileExtension))
  return (runtime && runtime.length > 0) ? `${runtime[0]}:default` : undefined
}

// Does file extension imply binary data?
export function isBinaryFileExtension(fileExtension: RuntimeFileExtension): boolean {
  return BinaryFileExtensions.has(fileExtension)
}

// Compute the expected file extension from a runtime name. 
// Runtime returned should match the option for whether file extension refers to binary data
export function fileExtensionForRuntime(runtime: RuntimeKind, isBinaryExtension: boolean): RuntimeFileExtension {
  debug_log(`fileExtensionForRuntime: runtime (${runtime}) binary (${isBinaryExtension})`)
  const isSameRuntime = (r: string): boolean => r.includes(runtime)
  const isValidRuntime = Object.keys(FileExtensionRuntimes).some(isSameRuntime)
  if (!isValidRuntime) throw new Error(`Invalid runtime ${runtime} encountered`)

  return isBinaryExtension ? FileExtensionRuntimes[runtime].filter((item) => BinaryFileExtensions.has(item))[0] : FileExtensionRuntimes[runtime][0]
}

// Does the runtime kind exist in the platform config?
export function isValidRuntime(runtimes: RuntimesConfig, kind: RuntimeKind): boolean {
  debug_log(`isValidRuntime: runtimes (${runtimes}) kind (${kind})`)
  const [_, version] = kind.split(':')
  //const images = runtimes[label] ?? []
  return Object.values(runtimes).some(images => images.some(i => version === 'default' ? i.default : i.kind === kind))
}

// Find the default runtime for a language
export function defaultRuntime(runtimes: RuntimesConfig, label: RuntimeLabel): RuntimeKind {
  debug_log(`defaultRuntime: runtimes (${runtimes}) label (${label})`)
  const kinds = runtimes[label] ?? []
  const defaultRuntime = kinds.find(k => k.default) ?? { kind: undefined }
  return defaultRuntime.kind
}

// Compute a runtime kind from the 'mid string' of a file name of the form name.runtime.zip
export function runtimeForZipMid(runtimes: RuntimesConfig, mid: string): RuntimeKind {
  const runtime = mid.includes('-') ? mid.replace('-', ':') : `${mid}:default`
  return isValidRuntime(runtimes, runtime) ? runtime : undefined
}

// Return default kind for runtime label - if explicit version isn't used.
export function canonicalRuntime(runtimes: RuntimesConfig, runtime: RuntimeKind) {
  if (runtime.endsWith(':default')) {
    const [label] = runtime.split(':')
    return defaultRuntime(runtimes, label)
  }
  return runtime
}

// Custom type guard to ensure JSON response is in the correct format
function isValidRuntimesJson(src: Record<string, unknown>): src is RuntimesConfig {
  return Object.values(src).every(v => Array.isArray(v) && v.every(k => k.hasOwnProperty('kind')))
}

// Load runtimes JSON configuration file from platform endpoint
export async function load(apihost: string): Promise<RuntimesConfig> {
  const runtimes = await fromPlatform(axios, apihost)
  if (!isValidRuntimesJson(runtimes)) {
    throw new Error(`Invalid runtime JSON received from platform API: ${apihost}`)
  }
  return runtimes
}

// Initialize runtimes configuration from platform host for current namespace.
// The parsed runtime configuration will be stored in a local cache.
// API host parameter is used as the cache key.
// The cached values will be returned after the first call.
export async function init(): Promise<RuntimesConfig> {
  const creds = await getCredentials(authPersister)
  const apihost = creds.ow.apihost
  debug_log(`init: creds (${creds})`)
  if (!apihost) throw new Error('Missing APIHOST parameter from current credentials')
  if (!RuntimesCache[apihost]) {
    RuntimesCache[apihost] = await load(apihost)
  }

  return RuntimesCache[apihost]
}
