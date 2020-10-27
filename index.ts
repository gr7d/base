import SessionHandler from "./session_handler.ts";
import { serve, serveTLS, Server, ServerRequest, Response as ServerResponse, HTTPOptions, HTTPSOptions } from "https://deno.land/std@v0.61.0/http/server.ts";
import { Md5 } from "https://deno.land/std@0.74.0/hash/md5.ts";
import { acceptWebSocket, WebSocket } from "https://deno.land/std@0.74.0/ws/mod.ts";
import { DOMParser, Element, Document } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";
import r from "https://dev.jspm.io/react";

export const React = r;
export const document: { [_: string]: any; } = {};

declare global {
    namespace JSX {
        interface IntrinsicElements {
            [element: string]: any;
        }
    }
}

interface JSXElement {
    type: string;
    props: {
        [attribute: string]: any;
        children: JSXElement[];
    };
}

interface Response {
    status?: number;
    body: any;
    headers?: Headers;
}

export interface Request {
    method: string;
    url: string;
    path: string;
    headers: Headers;
    contentLength: number | null;
    body: { [name: string]: string; };
    query: { [name: string]: string; };
    conn: Deno.Conn;
    r: any;
    w: any;
    done: any;
    respond(response: Response): void;
}

type Handler = (req: Request) => (void | string | Response) | Promise<void | string | Response>;

export interface Options {
    [name: string]: any;
}

interface UninitializedPage {
    new({ storage, session }: { storage: Storage; session: Session; }): Page;
}

export interface Page {
    endpoints?: { [name: string]: (options: Options) => Promise<void | { [s: string]: any; }>; };
    exposures?: { [name: string]: any; };
    template: string | { "$$typeof": Symbol; type: string; };
}

interface UnfixedPage extends Page {
    [key: string]: any;
}

interface SessionPage extends Page {
    _lastServedRawHTML: string;
    _lastUpdatedRawHTML: string;
}

export interface Storage {
    get(name: string): any;
    update(name: string, value: any): void;
    create(name: string, defaultValue: any): void;
}

export class BasePage {
    private intervals: any[] = [];

    public createInterval(callback: () => any, interval: number) {
        callback();
        this.intervals.push(setInterval(callback, interval));
    }

    public destroy() {
        console.log(this);
    }
}

export class Session {
    private readonly _id: string;
    private _pages: { [path: string]: SessionPage; } = {};
    public _storage: { pagePathThatModifiedThisEntry: string[]; name: string; value: any; }[] = [];
    public currentPagePath: string | null = null;

    constructor(id: string) {
        this._id = id;
    }

    public destroy() {
        setTimeout(() => {
            if (this.currentPagePath) delete this._pages[this.currentPagePath];
        }, 100);
    }

    get storage() {
        return {
            get: (name: string) => {
                return this._storage.find(entry => entry.name === name)?.value ?? null;
            },
            update: async (name: string, handler: (currentValue: any) => any) => {
                if (!this._storage.find(entry => entry.name === name)) {
                    return;
                }

                const entry = this._storage.find(entry => entry.name === name) as { pagePathThatModifiedThisEntry: string[]; name: string; value: any; };
                entry!.value = await handler(entry?.value);

                if (this.currentPagePath && !entry.pagePathThatModifiedThisEntry.includes(this.currentPagePath)) {
                    entry.pagePathThatModifiedThisEntry.push(this.currentPagePath);
                }
            },
            create: (name: string, defaultValue: any) => {
                if (this._storage.find(entry => entry.name === name)) {
                    return;
                }

                this._storage.push({ pagePathThatModifiedThisEntry: this.currentPagePath ? [ this.currentPagePath ] : [], name, value: defaultValue });
            }
        }
    }

    get id() {
        return this._id;
    }

    get pages() {
        return this._pages;
    }

    public addPage(path: string, page: SessionPage) {
        this._pages[path] = page;
    }
}

interface BaseOptions extends HTTPOptions {
    development?: boolean;
}

interface BaseTLSOptions extends HTTPSOptions {
    development?: boolean;
}

export default class Base {
    private readonly server: Server;
    private readonly options: BaseOptions | BaseTLSOptions;
    private pages: { [path: string]: UninitializedPage } = {};
    private handlers: Handler[] = [];
    private sessions: { [id: string]: Session } = {};
    private decoder: TextDecoder;

    constructor(options: BaseOptions | BaseTLSOptions) {
        this.decoder = new TextDecoder();
        this.options = options;
        this.server = (options as HTTPSOptions).keyFile
            ? serveTLS({ ...(options as HTTPSOptions) })
            : serve({ ...options  });
        this.handleRequests();
    }

    createMd5Hash(text: string): string {
        return new Md5().update(text).toString();
    }

    private getSessionPage(path: string, parameters: URLSearchParams, session: Session): SessionPage {
        if (!session.pages[path] && this.pages[path]) {
            session._storage = session._storage.filter(entry => !entry.pagePathThatModifiedThisEntry.includes(path));

            let temporaryPage: UnfixedPage = new this.pages[path]({ storage: session.storage, session });
            temporaryPage._lastServedHTML = "";

            const sessionPage = temporaryPage as SessionPage;
            session.addPage(path, sessionPage);
        }

        if (session.pages[path]?.template) session.currentPagePath = path;

        return session.pages[path];
    }

    private generateClientApp(exposures: { [name: string]: any; }) {
        return JSON.stringify(Object.keys(exposures).reduce((clientApp: { [name: string]: any; }, exposure) => {
            const type = typeof exposures[exposure] === "function" ? "function" : "value";
            const value = type === "function" ? exposures[exposure].toString() : exposures[exposure];

            return {
                ...clientApp,
                [exposure]: {
                    type,
                    value: type === "function" ? value.replace(/this/g, "app") : value
                }
            }
        }, {}));
    }

    private addUsefulHeadTagsAndDoctype(template: string): string {
        const templateWithoutHead = template.replace(/<(|\/)head.*?>/g, "");
        const htmlTag = template.match(/<html(.|\n)*?>/gm)?.[0] || "<html lang='en'>";

        return `
            ${htmlTag}
            <!DOCTYPE html>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            ${templateWithoutHead.replace(/<html(.|\n)*?>/, "")}
        `;
    }

    getTemplateHTML(page: Page): { template: string; foundFunctions: { name: string; handler: (...parameters: any) => any; }[] } {
        const foundFunctions: { attribute: string; name: string; handler: (...parameters: any) => any; }[] = [];

        try {
            if (typeof page.template === "string") {
                return { template: page.template, foundFunctions };
            }

            function generateFromJSX(element: JSXElement) {
                const eventListeners = Object.keys(element.props).filter(prop => prop.startsWith("on"));
                const foundFunctionsInElement: { attribute: string; name: string; handler: (...parameters: any) => any; }[] = [];

                for (const eventListener of eventListeners) {
                    let name = element.props[eventListener].name;

                    if (element.props[eventListener].name === eventListener) {
                        name += element.type + element.props.children.length;
                    }

                    foundFunctionsInElement.push({ attribute: eventListener, name, handler: element.props[eventListener] });
                }
                foundFunctions.push(...foundFunctionsInElement);

                let html = `<${element.type}`;
                for (const foundFunction of foundFunctionsInElement) {
                    html += ` @${foundFunction.attribute.toLowerCase()}=${foundFunction.name}`;
                }

                for (const attribute of Object.keys(element.props).filter(attribute => attribute !== "children" && !eventListeners.includes(attribute))) {
                    const replacements = [{
                        search: "className",
                        replacement: "class"
                    }];

                    if (typeof element.props[attribute] === "string" || element.props[attribute] === true) {
                        let attributeAfterReplacements = attribute;

                        for (const { search, replacement } of replacements) {
                            let attributeBefore = attributeAfterReplacements;
                            attributeAfterReplacements = attributeAfterReplacements.replace(search, replacement);
                            if (attributeBefore !== attributeAfterReplacements) break;
                        }

                        html += ` ${attributeAfterReplacements}='${element.props[attribute]}'`;
                        continue;
                    }

                    html += ` data-value-for='${attribute};${JSON.stringify(element.props[attribute])}'`;
                }

                html += ">";

                const c: JSXElement[] = element.props.children?.length ? element.props.children : [element.props.children as any].filter(c => c);
                for (let child of c) {
                    if (typeof child.type === "function") {
                        child = (child.type as any)(child.props);
                    }

                    if (["string", "number"].includes(typeof child)) {
                        html += child;
                        continue;
                    }

                    html += generateFromJSX(child);
                }

                const elementsWithNoClosingBrackets = ["area", "base", "br", "col", "command", "embed", "hr", "input", "img", "keygen", "link", "meta", "param", "source", "track", "wbr"];
                if (!elementsWithNoClosingBrackets.includes(element.type)) html += `</${element.type}>`;
                return html;
            }

            return { template: generateFromJSX(page.template as any), foundFunctions };
        }catch(error) {
            console.error(error);
            return { template: error.toString(), foundFunctions };
        }
    }

    private setCorrectListenerAttributes(html: string): string {
                // html.replace(/@on(.*?)\=(\s|"|'|)([a-zA-Z_0-9]*)("|'|)/g, `data-on-event=$1;$3`);
        // @TODO: seperate by event listeners (event=listener;event=listener)
        return html.replace(/<[^<>]*?@on.*?>/g, (match: string) => {
            const onAttributes = match.match(/@on(.*?)\=(\s|"|'|)([a-zA-Z_0-9]*)("|'|)/g);

            const eventPairs = [];
            for (const onAttribute of onAttributes || []) {
                const eventListenerPair = onAttribute.split("=");
                const event = eventListenerPair[0].replace("@on", "");
                const listener = eventListenerPair[1];
                eventPairs.push(`${event}=${listener}`);
            }

            return match
                .replace(/@on(.*?)\=(\s|"|'|)([a-zA-Z_0-9]*)("|'|)/g, "")
                .replace(">", ` data-on-event="${eventPairs.join(";")}">`);
        });
    }

    private parseTemplate(page: Page): string {
        const exposures = page.exposures || {};
        const endpoints = page.endpoints || {};
        const { template, foundFunctions } = this.getTemplateHTML(page);

        for (const foundFunction of foundFunctions) {
            exposures[foundFunction.name] = foundFunction.handler;
        }

        const clientApp = this.generateClientApp(exposures || {});

        const injectionScript = `<script>
            function setCorrectObjectValues() {
                document.querySelectorAll("[data-value-for]").forEach(elementWithObjectValue => {
                    const [attribute, jsonValue] = elementWithObjectValue.getAttribute("data-value-for").split(";");
                    elementWithObjectValue.removeAttribute("data-value-for");
                    const value = JSON.parse(jsonValue);
                    
                    if (value?.length) {
                        elementWithObjectValue[attribute] = value;
                        return;
                    }

                    for (const valueKey of Object.keys(value)) {
                        elementWithObjectValue[attribute][valueKey] = value[valueKey];
                    }
                });
            }
            setCorrectObjectValues();

            const app = JSON.parse(${JSON.stringify(clientApp)});
            
            async function callEndpoint(endpoint, options) {
                return await (await fetch(document.location.href.replace(/\\/$/, "") + "/api/" + endpoint, {
                    method: "post",
                    body: JSON.stringify(options)
                })).json();
            }
            
            Object.keys(app).forEach(function(exposure) {
                if (app[exposure].type === "function") {
                    eval("var temp = {" + (app[exposure].value.trimLeft().split("\\n")?.[0]?.match(new RegExp(exposure + "\(.*?\).*?{")) ? app[exposure].value : exposure + ":" + app[exposure].value) + "}");
                    app[exposure] = temp[exposure];
                }else {
                    app[exposure] = app[exposure].value;
                }
                
                if (exposure.startsWith("on") && window[exposure] !== undefined) {
                    window[exposure] = event => app[exposure](event);
                }
            });
            
            app.exposures = app;
            const fakeEndpointsObject = JSON.parse('${JSON.stringify(Object.keys(endpoints || {}))}').reduce((endpoints, endpoint) => {
                if (!endpoints[endpoint]) endpoints[endpoint] = async (options) => await callEndpoint(endpoint, options);
                return endpoints;
            }, {});
            app.endpoints = fakeEndpointsObject;
            
            function bindEventListeners() {
                document.querySelectorAll("[data-on-event]").forEach(elementWithEventListener => {
                    const onEventValue = elementWithEventListener.getAttribute("data-on-event");
                    const pairs = onEventValue.split(";");
                    
                    for (const pair of pairs) {
                        const [event, listener] = pair.split("=");
                        elementWithEventListener["on" + event] = (event) => app[listener](event);
                    }
                    
                    elementWithEventListener.removeAttribute("data-on-event");
                });
            }
            
            const ws = new WebSocket("ws" + (document.location.protocol.includes("https") ? "s://" : "://") + document.location.hostname + (document.location.port.length > 1 ? ":" + document.location.port : "") + document.location.pathname + "/socket");
            ws.onmessage = function(event) {
                const details = event.data.trimRight().split("[t--c]");
                const type = details[0];
                const content = details[1];
                
                switch (type) {
                    case "update_content":
                        const updateElements = JSON.parse(content);
                        
                        for (const updateElement of updateElements) {
                            if (!updateElement.newContent || !updateElement.steps) continue;
                            let currentParent = document.body;
                            
                            for (const step of updateElement.steps) {
                                currentParent = currentParent.children[step];
                            }
                            
                            if (currentParent.outerHTML === updateElement.newContent) continue;
                            
                            console.log("Updated", currentParent, "with", updateElement.newContent);
                            currentParent.outerHTML = updateElement.newContent;
                        }
                        
                        setCorrectObjectValues();
                        bindEventListeners();
                        break;
                }
            }
            
            bindEventListeners();
        </script>`;

        const templateWithValidAttributes = this.setCorrectListenerAttributes(template);
        const templateWithUsefulInformation = this.addUsefulHeadTagsAndDoctype(templateWithValidAttributes);
        return templateWithUsefulInformation + injectionScript;
    }

    private getBodyDifferences(oldDom: Document, newDom: Document): { steps: number[], newContent: string }[] {
        function uniquifyElement(element: Element): string {
            const excludedAttributes = ["value"];
            let hash: string = element.tagName;
            let tempElement: Element = element;

            while (tempElement.parentElement) {
                if (tempElement.tagName === "BODY") break;

                let t = "";
                for (const a of Object.keys(tempElement.attributes)) {
                    if (excludedAttributes.includes(a)) continue;
                    t += a + tempElement.attributes[a];
                }

                hash += tempElement.className + t;
                tempElement = tempElement.parentElement;
            }

            return hash;
        }

        function getStepsFromBodyDownwards(element: Element): number[] {
            const steps: number[] = [];
            let currentElement: Element = element;

            while (currentElement.parentElement) {
                if (currentElement.tagName === "BODY") break;
                steps.push(Array.from(currentElement.parentElement!.children).indexOf(currentElement));
                currentElement = currentElement.parentElement;
            }

            return steps.reverse();
        }

        function isSameNode(element1: Element, element2: Element) {
            return element1.outerHTML === element2.outerHTML;
        }

        const newElements: Element[] = Array.from(newDom.querySelectorAll("body *")) as Element[];

        let notAlreadyExistingElements: Element[] = [];
        for (const newElement of newElements) {
            let isInDocument = false;
            for (const oldElement of (Array.from(oldDom.querySelectorAll(`body ${newElement.tagName}`)) as Element[])) {
                if (isSameNode(newElement, oldElement)) {
                    isInDocument = true;
                    break;
                }
            }

            if (isInDocument) continue;
            notAlreadyExistingElements.push(newElement);
        }

        for (const notAlreadyExistingElement of notAlreadyExistingElements) {
            let currentElement = notAlreadyExistingElement;

            while (currentElement.parentElement) {
                currentElement = currentElement.parentElement;
                if (currentElement.tagName === "BODY") break;

                for (const notAlreadyExistingOtherElement of Array.from(newDom.querySelectorAll(`body ${currentElement.tagName}`))) {
                    if (uniquifyElement(currentElement) === uniquifyElement(notAlreadyExistingOtherElement as Element)) {
                        notAlreadyExistingElements = notAlreadyExistingElements.filter((element) => element !== notAlreadyExistingOtherElement);
                    }
                }
            }
        }

        const transferInformation = [];
        for (const notAlreadyExistingElement of notAlreadyExistingElements) {
            let matchingElementInOldDocument: Element = oldDom.querySelector("body") as Element;
            let currentElement = notAlreadyExistingElement;

            while (currentElement) {
                if (currentElement.tagName === "BODY") break;
                const possibleMatchingElementInOldDocument = (Array.from(oldDom.querySelectorAll(`body ${currentElement.tagName}`)) as Element[])
                    .find(oldElement => uniquifyElement(oldElement) === uniquifyElement(currentElement));

                if (possibleMatchingElementInOldDocument) {
                    matchingElementInOldDocument = possibleMatchingElementInOldDocument;
                    break;
                }

                if (!currentElement.parentElement) break;
                currentElement = currentElement.parentElement;
            }

            const steps = getStepsFromBodyDownwards(matchingElementInOldDocument);
            const jsonSteps = JSON.stringify(steps);

            let elementIsAlreadyGettingUpdated = false;
            for (const singleTransferInformation of transferInformation) {
                if (JSON.stringify(singleTransferInformation.steps) === jsonSteps) {
                    elementIsAlreadyGettingUpdated = true;
                    break;
                }
            }

            if (elementIsAlreadyGettingUpdated) continue;
            transferInformation.push({
                steps: getStepsFromBodyDownwards(matchingElementInOldDocument as Element),
                newContent: this.setCorrectListenerAttributes(currentElement.outerHTML)
            });
        }

        return transferInformation;
    }

    private async handleWebSocketConnection(socket: WebSocket, page: SessionPage) {
        page._lastUpdatedRawHTML = page._lastServedRawHTML;

        const contentUpdater = setInterval(async () => {
            const { template: currentRenderedHTML } = this.getTemplateHTML(page);

            if (currentRenderedHTML !== page._lastUpdatedRawHTML) {
                page._lastUpdatedRawHTML = currentRenderedHTML;
                const oldDom: Document = new DOMParser().parseFromString(page._lastServedRawHTML || "", "text/html")!;
                const newDom: Document = new DOMParser().parseFromString(currentRenderedHTML || "", "text/html")!;
                const transferInformation = this.getBodyDifferences(oldDom, newDom);

                // Push message size -> https://github.com/denoland/deno/issues/8022
                const minimumMessageLength = 1e4;
                let stringifiedTransferInformation = JSON.stringify(transferInformation);
                const transferInformationSize = stringifiedTransferInformation.length;

                if (transferInformationSize < minimumMessageLength) stringifiedTransferInformation += " ".repeat(minimumMessageLength - transferInformationSize);

                try {
                    await socket.send(`update_content[t--c]${stringifiedTransferInformation}`);
                }catch {
                    clearInterval(contentUpdater);
                    socket.closeForce();
                }
            }
        }, 75);
    }

    private async handleWebSocketRequest(req: Request, parameters: URLSearchParams, session: Session, conn: any, bufReader: any, bufWriter: any, headers: Headers) {
        const { pathname: pagePath } = new URL("http://localhost" + req.url.replace("/socket", ""));
        const page = this.getSessionPage(pagePath, parameters, session);

        if (!page) {
            req.respond({ body: "Could not setup socket connection." });
            return;
        }

        try {
            await this.handleWebSocketConnection(await acceptWebSocket({ conn, bufReader, bufWriter, headers }), page);
        }catch {
            req.respond({ body: "Could not setup socket connection." });
        }
    }

    private getSession(req: Request, res: any, path: string): Session {
        let sessionID: string = SessionHandler.getSessionID(req.headers);

        if (!sessionID || !this.sessions[sessionID]) {
            const newSessionID = String(Math.floor(Math.random() * 1e16).toString(32));
            res.headers!.append("Set-Cookie", `base=${newSessionID}`);
            this.sessions[newSessionID] = new Session(newSessionID);
            sessionID = newSessionID;
        }

        return this.sessions[sessionID];
    }

    private async handleEndpointRequest(req: Request, path: string, parameters: URLSearchParams, session: Session) {
        const { pathname: pagePath } = new URL("http://localhost" + (req.url.replace(/\/api(.*)/, "") === "" ? "/" : req.url.replace(/\/api(.*)/, "")));
        const page = this.getSessionPage(pagePath, parameters, session);

        if (!page) {
            req.respond({ body: "Endpoint does not exist.", status: 404 });
            return;
        }

        const endpoint = new URL("http://localhost" + req.url.replace(/.*api(?=\/)/, "")).pathname.replace(/^\//, "");

        if (!page.endpoints?.[endpoint]) {
            req.respond({ body: "Endpoint does not exist." });
            return;
        }

        req.respond({ body: JSON.stringify(await page.endpoints?.[endpoint](req.body)) || "{}" });
    }

    private async handlePublicResourceRequest(req: Request, path: string) {
        const resource = path.replace(/.*\/(?=public\/)/, "");
        const extension = resource.replace(/.*(?=\.)/, "");
        const contentType = (() => {
            switch (extension) {
                case ".svg": return "image/svg+xml";
            }
        })();

        try {
            req.respond({ headers: contentType ? new Headers({ "Content-Type": contentType, "Cache-Control": "max-age=7776000000" }) : new Headers({ "Cache-Control": "max-age=7776000000" }), body: await Deno.readFile(resource) });
        }catch (error) {
            if ((error as Error).name === "PermissionDenied") {
                // throw Error("Couldn't")
            }
            req.respond({ status: 404, body: "File not found." });
        }
    }

    private parseQuery(req: Request | ServerRequest): { [name: string]: string; } {
        if (!req.url.includes("?")) return {};

        const queryString: string[] = req.url.replace(/(.*)\?/, "").split("&");

        return queryString.reduce((queries: {}, query: string): {} => {
            if (!query || !query.split("=")?.[0] || query.split("=")?.[1] === undefined) return queries;

            return {
                ...queries,
                [decodeURIComponent(query.split("=")?.[0])]: decodeURIComponent(query.split("=")?.[1].replace(/\+/g, " "))
            }
        }, {}) || {};
    }

    private async parseBody(req: Request | ServerRequest): Promise<{ [name: string]: string; }> {
        if (!req.contentLength) return {};

        const buffer: Uint8Array = new Uint8Array(req.contentLength || 0);
        const lengthRead: number = await (req.body as any).read(buffer) || 0;
        const rawBody: string = new TextDecoder().decode(buffer.subarray(0, lengthRead));
        let body: {} = {};

        if (!rawBody) return {};

        try {
            body = JSON.parse(rawBody);
        }catch(error) {
            if (rawBody.includes(`name="`)) {
                body = (rawBody.match(/name="(.*?)"(\s|\n|\r)*(.*)(\s|\n|\r)*---/gm) || [])
                    .reduce((fields: {}, field: string): {} => {
                        if (!/name="(.*?)"/.exec(field)?.[1]) return fields;

                        return {
                            ...fields,
                            [/name="(.*?)"/.exec(field)?.[1] || ""]: field.match(/(.*?)(?=(\s|\n|\r)*---)/)?.[0]
                        }
                    }, {});
            }
        }

        return body;
    }

    private async handleRequests() {
        for await (const _req of this.server) {
            const body: { [name: string]: string; } = await this.parseBody(_req);
            const query: { [name: string]: string; } = await this.parseQuery(_req);
            const { pathname: path, searchParams: parameters } = new URL("http://localhost" + _req.url);
            const req: Request = {
                body,
                path,
                query,
                method: _req.method,
                conn: _req.conn,
                contentLength: _req.contentLength,
                headers: _req.headers,
                r: _req.r,
                url: _req.url,
                w: _req.w,
                respond: _req.respond,
                done: _req.done
            };

            let handlerMatched = false;
            for await (const handler of this.handlers) {
                const handlerResponse = await handler(req);
                if (typeof handlerResponse === "string" || (typeof handlerResponse === "object" && handlerResponse.body)) {
                    handlerMatched = true;
                    if (typeof handlerResponse === "string") {
                        req.respond({ body: handlerResponse });
                    }else if (typeof handlerResponse === "object") {
                        req.respond(handlerResponse);
                    }
                }
            }
            if (handlerMatched) continue;

            const res = { headers: new Headers(), body: "No page found, yo!", status: 404 };
            const session: Session = this.getSession(req, res, path);

            if (req.url.endsWith("/socket")) {
                await this.handleWebSocketRequest(req, parameters, session, req.conn, req.r, req.w, req.headers);
                continue;
            }

            if (req.url.includes("/api/")) {
                await this.handleEndpointRequest(req, path, parameters, session);
                continue;
            }

            if (req.url.includes("/public/")) {
                await this.handlePublicResourceRequest(req, path);
                continue;
            }

            const page: SessionPage = this.getSessionPage(path, parameters, session);
            res.headers.append("Content-Type", "text/html");
            res.headers.append("Cache-Control", "max-age=0, must-revalidate");

            if (page?.template) {
                res.status = 200;
                const currentParsedTemplate = this.parseTemplate(page);

                if (
                    (!page._lastUpdatedRawHTML ||  page._lastServedRawHTML === page._lastUpdatedRawHTML)
                    && req.headers.get("If-None-Match") === this.createMd5Hash(currentParsedTemplate)
                ) {
                    res.status = 304;
                }

                page._lastServedRawHTML = this.getTemplateHTML(page).template;
                res.body = currentParsedTemplate;
                res.headers.append("etag", this.createMd5Hash(res.body));
            }

            req.respond(res);
        }
    }

    public register(path: string, page: UninitializedPage) {
        this.pages[path] = page;
    }

    public use(handler: Handler) {
        this.handlers.push(handler);
    }

    public killSessions() {
        this.sessions = {};
    }
}
