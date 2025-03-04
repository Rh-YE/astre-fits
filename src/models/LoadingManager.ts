export class LoadingManager {
    private loadingFiles: Map<string, Promise<void>> = new Map();
    private static instance: LoadingManager;

    private constructor() {}

    public static getInstance(): LoadingManager {
        if (!LoadingManager.instance) {
            LoadingManager.instance = new LoadingManager();
        }
        return LoadingManager.instance;
    }

    public async startLoading(fileUri: string, loadingPromise: Promise<void>): Promise<void> {
        if (this.loadingFiles.has(fileUri)) {
            // If file is already loading, wait for existing load to complete / 如果文件正在加载，等待现有的加载完成
            return this.loadingFiles.get(fileUri)!;
        }

        this.loadingFiles.set(fileUri, loadingPromise);
        try {
            await loadingPromise;
        } finally {
            this.loadingFiles.delete(fileUri);
        }
    }

    public isLoading(fileUri: string): boolean {
        return this.loadingFiles.has(fileUri);
    }
} 