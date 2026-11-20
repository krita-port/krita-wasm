import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { readTar } from '../web/bundle.ts'

function archive(names: string[]) {
  return execFileSync('python3', [
    '-c',
    `
import io,json,sys,tarfile
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
 for name in json.loads(sys.argv[1]):
  data=b'payload'*77
  entry=tarfile.TarInfo(name);entry.size=len(data)
  archive.addfile(entry,io.BytesIO(data))
`,
    JSON.stringify(names),
  ])
}
async function collect(bytes: Uint8Array) {
  const files: { name: string, data: Buffer }[] = []
  // Deliberately split headers, file contents and padding across chunks.
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 137) controller.enqueue(bytes.subarray(i, i + 137))
      controller.close()
    },
  })
  await readTar(stream, (name, data) => files.push({
    name,
    data: Buffer.from(data),
  }), 4096)
  return files
}
const longName = `krita/share/${'directory/'.repeat(12)}resource`
const files = await collect(archive(['first', longName]))
assert.deepEqual(files.map(file => file.name), ['first', longName])
assert.equal(files[1].data.toString(), 'payload'.repeat(77))
await assert.rejects(collect(archive(['../escape'])), /archive path/)
await assert.rejects(collect(archive(['same', 'same'])), /duplicate/)
const corrupt = archive(['first'])
corrupt[0] ^= 1
await assert.rejects(collect(corrupt), /header/)
await assert.rejects(collect(archive(['first']).subarray(0, 550)), /Truncated/)
