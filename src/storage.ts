import config from "./config"

type DirectoryHandle = FileSystemDirectoryHandle & AsyncIterable<[string, FileSystemHandle]>

const folderPromise = navigator.storage.getDirectory()
  .then(async root => {
    //remove old versions
    for await (const [name] of root as DirectoryHandle) {
      if (name != config.piperVer)
        await root.removeEntry(name, {recursive: true})
    }
    return root.getDirectoryHandle(config.piperVer, {create: true})
  })

export async function getFile(name: string, fetchFile?: () => Promise<Blob>): Promise<Blob> {
  name = name.replace(/\//g, '$')
  const folder = await folderPromise
  try {
    const file = await folder.getFileHandle(name)
    return file.getFile()
  }
  catch (err) {
    if (fetchFile && err instanceof DOMException && err.name == "NotFoundError") {
      const blob = await fetchFile()
      folder.getFileHandle(name, {create: true})
        .then(async file => {
          const writable = await file.createWritable()
          await writable.write(blob)
          await writable.close()
        })
        .catch(console.error)
      return blob
    }
    else {
      throw err
    }
  }
}

export function getStats() {
  return navigator.storage.estimate()
}
