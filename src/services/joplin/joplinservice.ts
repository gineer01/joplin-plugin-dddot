import * as crypto from "crypto";
import ThemeType from "../../types/themetype";
import JoplinRepo from "../../repo/joplinrepo";
import PlatformRepo from "../../repo/platformrepo";
import { Link, LinkMonad } from "../../types/link";
import TimerRepo from "../../repo/timerrepo";

export async function sha256(message) {
    return crypto.createHash("sha256").update(message).digest("hex");
}

export default class JoplinService {
    static Cancel = "Cancel";

    static OK = "OK";

    dialogHandle = "";

    joplinRepo: JoplinRepo;

    platformRepo: PlatformRepo;

    timerRepo: TimerRepo;

    constructor(
        joplinRepo: JoplinRepo,
        platformRepo: PlatformRepo = new PlatformRepo(),
        timerRepo: TimerRepo = new TimerRepo(),
    ) {
        this.joplinRepo = joplinRepo;
        this.platformRepo = platformRepo;
        this.timerRepo = timerRepo;
    }

    async* dataGet(query, options) {
        let hasMore = true;
        let page = 1;

        while (hasMore) {
            const result = await this.joplinRepo.dataGet(query, { ...options, page });
            yield result;
            if (result.has_more) {
                page += 1;
            } else {
                hasMore = false;
            }
        }
    }

    async getNote(noteId: string, fields = undefined) {
        const options : any = {};
        if (fields !== undefined) {
            options.fields = fields;
        }
        return this.joplinRepo.dataGet(["notes", noteId], options);
    }

    async createNoteLink(noteId: string): Promise<Link> {
        const note = await this.joplinRepo.dataGet(
            ["notes", noteId],
            {
                fields: ["id", "title", "is_todo", "todo_completed"],
            },
        );
        return LinkMonad.createNoteLinkFromRawData(note);
    }

    async createFolderLink(folderId: string): Promise<Link> {
        const folder = await this.joplinRepo.dataGet(
            ["folders", folderId],
            {
                fields: ["id", "title"],
            },
        );
        return LinkMonad.createFolderLink(folder.id, folder.title);
    }

    async searchBacklinks(id: string): Promise<Link[]> {
        let hasMore = true;
        let page = 1;
        let items = [];
        while (hasMore) {
            const notes = await this.joplinRepo.dataGet(
                ["search"],
                {
                    query: id,
                    fields: ["id", "title", "is_todo", "todo_completed"],
                    page,
                },
            );
            items = items.concat(notes.items);
            if (notes.has_more) { page += 1; } else { hasMore = false; }
        }

        const links = items.map(
            (item) => LinkMonad.createNoteLinkFromRawData(item),
        );
        return links;
    }

    async showMessageBox(message: string) {
        return this.platformRepo.isLinux()
            ? this.showMessageBoxCustom(message)
            : this.showMessageBoxNative(message);
    }

    async showMessageBoxCustom(message: string) {
        if (this.dialogHandle === "") {
            this.dialogHandle = await this.joplinRepo.dialogCreate("dddot.joplinservice.messageBox");
        }

        await this.joplinRepo.dialogSetHtml(this.dialogHandle, `<h3>${message}</h3>`);

        await this.joplinRepo.dialogSetButtons(this.dialogHandle, [
            {
                id: "ok",
            },
            {
                id: "cancel",
            },
        ]);

        const result = await this.joplinRepo.dialogOpen(this.dialogHandle);

        return result.id === "ok" ? JoplinService.OK : JoplinService.Cancel;
    }

    async showMessageBoxNative(message: string) {
        const result = await this.joplinRepo.dialogShowMessageBox(message);
        return result === 0 ? JoplinService.OK : JoplinService.Cancel;
    }

    async queryThemeType(): Promise<ThemeType> {
        return await this.joplinRepo.settingsLoadGlobal("theme", ThemeType.THEME_UNKNOWN) as ThemeType;
    }

    async updateNoteBody(noteId: string, body: string) {
        return this.joplinRepo.dataPut(["notes", noteId], null, { body });
    }

    async appendTextToNote(noteId: string, text: string) {
        const {
            joplinRepo,
        } = this;

        const {
            id: currentNoteId,
        } = await joplinRepo.workspaceSelectedNote();
        if (currentNoteId === noteId) {
            await joplinRepo.commandsExecute("textSelectAll");
            const selectedText = (await joplinRepo.commandsExecute("selectedText") as string);
            const newBody = selectedText + text;
            await joplinRepo.commandsExecute("replaceSelection", newBody);
            return newBody;
        }

        const note = await this.getNote(noteId, ["body"]);
        const {
            body,
        } = note;
        const newBody = body + text;
        await this.updateNoteBody(noteId, newBody);
        return newBody;
    }

    openNote(noteId: string) {
        const {
            joplinRepo,
        } = this;
        joplinRepo.commandsExecute("openNote", noteId);
    }

    async openNoteByIndex(index: number) {
        const notes = await this.joplinRepo.dataGet(["notes"], { limit: 1, page: index });
        const item = notes.items[0];
        this.openNote(item.id);
    }

    async openNoteAndWaitOpened(noteId: string, timeout: number = TimerRepo.DEFAULT_TIMEOUT) {
        const {
            joplinRepo,
            timerRepo,
        } = this;

        await timerRepo.tryWaitUntilTimeout(async () => {
            this.openNote(noteId);
            const note = await joplinRepo.workspaceSelectedNote();
            return note.id === noteId;
        }, timeout);
    }

    async urlToId(url: string): Promise<string> {
        return (await sha256(url)).slice(0, 32);
    }

    async createNoteWithIdIfNotExists(noteId: string, title: string, options: any = undefined) {
        const {
            joplinRepo,
        } = this;

        const {
            parentId,
        } = options;

        const path = ["notes", noteId];

        try {
            const node = await joplinRepo.dataGet(path);
            return node;
        } catch (e) {
            // Note does not exist, create it
        }

        return joplinRepo.dataPost(path, undefined, {
            id: noteId,
            title,
            parent_id: parentId,
        });
    }

    async queryNotebookId(name: string) {
        let items = [];
        const query = this.dataGet(["folders"], { fields: ["id", "title"] });

        // eslint-disable-next-line
        for await (const result of query) {
            items = items.concat(result.items);
        }

        const notebook = items.find((item) => item.title === name);

        return notebook?.id ?? "";
    }

    async calcNoteCount() {
        let page = 512;
        let maxPage = null;
        let minPage = 0;

        while (page > minPage) {
            const notes = await this.joplinRepo.dataGet(["notes"], { limit: 1, page });
            if (notes.has_more) {
                minPage = page;
                if (maxPage === null) {
                    page *= 2;
                } else {
                    page = Math.floor((maxPage - page) / 2 + page);
                }
            } else { // no more items
                maxPage = page;
                page = Math.floor((page - minPage) / 2 + minPage);
            }
        }

        return minPage;
    }
}
