import { AbstractFileProviderService } from "@medusajs/framework/utils";
import type { FileTypes } from "@medusajs/framework/types";
import { StorageRouter } from "./storage";
import type { RoutedFileOptions } from "./storage";

export default class RoutedFileProvider extends AbstractFileProviderService {
  static identifier = "gospaza-routed-file";
  private storage: StorageRouter;
  constructor(_container: Record<string, unknown>, options: RoutedFileOptions) {
    super();
    this.storage = new StorageRouter(options);
  }
  async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
    const extensions: Record<string, string> = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
    const extension = extensions[file.mimeType];
    if (!extension) throw new Error("Unsupported file content type.");
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content) throw new Error("Canonical base64 file content required.");
    if (file.access === "public" && file.mimeType === "application/pdf") throw new Error("Public documents are not supported.");
    return this.storage.upload(bytes, file.mimeType, file.access === "public" ? "public" : "private", extension);
  }
  async delete(files: FileTypes.ProviderDeleteFileDTO | FileTypes.ProviderDeleteFileDTO[]) {
    for (const file of Array.isArray(files) ? files : [files]) await this.storage.remove(file.fileKey);
  }
  async getAsBuffer(file: FileTypes.ProviderGetFileDTO) { return this.storage.read(file.fileKey); }
  async getDownloadStream(file: FileTypes.ProviderGetFileDTO) { return this.storage.stream(file.fileKey); }
  async getPresignedDownloadUrl(file: FileTypes.ProviderGetFileDTO) { return this.storage.downloadUrl(file.fileKey); }
  // Direct-to-storage upload is intentionally unsupported: actor routes validate bytes first.
}
