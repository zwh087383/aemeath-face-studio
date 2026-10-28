/** Verify the exact decoded resource payload before parsing or binding. The
 * compressed file hash in the inventory remains provenance for offline tools;
 * this second hash is usable by the browser's existing JSON resource endpoint. */
export async function verifyNativePayload(bytes,expectedSha256) {
  if(!/^[a-f0-9]{64}$/.test(expectedSha256??''))throw Error('native_source_fingerprint_missing');
  const view=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  const digest=await globalThis.crypto.subtle.digest('SHA-256',view);
  const actual=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  if(actual!==expectedSha256)throw Error('native_source_fingerprint_mismatch');
  const data=JSON.parse(new TextDecoder().decode(view));
  Object.defineProperty(data,'verifiedSourcePayloadSha256',{value:actual,enumerable:false,writable:false});return data;
}
export async function readVerifiedNativeJSON(url,expectedSha256,fetcher=globalThis.fetch) {
  const response=await fetcher(url);if(!response.ok)throw Error('native_source_http_'+response.status);
  return verifyNativePayload(await response.arrayBuffer(),expectedSha256);
}
