import tutorial from "components/tutorial";
import alert from "dialogs/alert";
import box from "dialogs/box";
import fsOperation from "fileSystem";
import markdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import MarkdownItGitHubAlerts from "markdown-it-github-alerts";
import mimeType from "mime-types";
import mustache from "mustache";
import path from "path-browserify";
import browser from "plugins/browser";
import Url from "utils/Url";
import helpers from "utils/helpers";
import $_console from "views/console.hbs";
import $_markdown from "views/markdown.hbs";
import constants from "./constants";
import EditorFile from "./editorFile";
import EditorManager from "./editorManager";
import openFolder, { addedFolder } from "./openFolder";
import appSettings from "./settings";

/**@type {Server} */
let webServer;

/**
 * Starts the server and run the active file in browser
 * @param {Boolean} isConsole
 * @param {"inapp"|"browser"} target
 * @param {Boolean} runFile
 */
async function run(
	isConsole = false,
	target = appSettings.value.previewMode,
	runFile = false,
) {
	if (!isConsole && !runFile) {
		const { serverPort, previewPort, previewMode, disableCache, host } =
			appSettings.value;
		if (serverPort !== previewPort) {
			const src = `http://${host}:${previewPort}`;
			if (previewMode === "browser") {
				system.openInBrowser(src);
				return;
			}

			browser.open(src);
			return;
		}
	}

	/** @type {EditorFile} */
	const activeFile = isConsole ? null : editorManager.activeFile;
	if (!isConsole && !(await activeFile?.canRun())) return;

	if (!isConsole && !localStorage.__init_runPreview) {
		localStorage.__init_runPreview = true;
		tutorial("run-preview", strings["preview info"]);
	}

	const uuid = helpers.uuid();

	let isLoading = false;
	let filename, pathName, extension;
	let port = appSettings.value.serverPort;
	let EXECUTING_SCRIPT = uuid + "_script.js";
	const MIMETYPE_HTML = mimeType.lookup("html");
	const CONSOLE_SCRIPT = uuid + "_console.js";
	const MARKDOWN_STYLE = uuid + "_md.css";
	const queue = [];

	if (activeFile) {
		filename = activeFile.filename;
		pathName = activeFile.location;
		extension = Url.extname(filename);

		if (!pathName && activeFile.uri) {
			pathName = Url.dirname(activeFile.uri);
		}
	}

	if (runFile && extension === "svg") {
		try {
			const fs = fsOperation(activeFile.uri);
			const res = await fs.readFile();
			const blob = new Blob([new Uint8Array(res)], {
				type: mimeType.lookup(extension),
			});

			box(filename, `<img src='${URL.createObjectURL(blob)}'>`);
		} catch (err) {
			helpers.error(err);
		}
		return;
	}

	if (!runFile && filename !== "index.html" && pathName) {
		const folder = openFolder.find(activeFile.uri);

		if (folder) {
			const { url } = folder;
			const fs = fsOperation(Url.join(url, "index.html"));

			try {
				if (await fs.exists()) {
					filename = "index.html";
					extension = "html";
					pathName = url;
					start();
					return;
				}

				next();
				return;
			} catch (err) {
				helpers.error(err);
				return;
			}
		}
	}

	next();

	function next() {
		if (extension === ".js" || isConsole) startConsole();
		else start();
	}

	function startConsole() {
		if (!isConsole) EXECUTING_SCRIPT = activeFile.filename;
		isConsole = true;
		target = "inapp";
		filename = "console.html";

		//this extra www is incorrect because asset_directory itself has www
		//but keeping it in case something depends on it
		pathName = `${ASSETS_DIRECTORY}www/`;
		port = constants.CONSOLE_PORT;

		start();
	}

	function start() {
		if (target === "browser") {
			system.isPowerSaveMode((res) => {
				if (res) {
					alert(strings.info, strings["powersave mode warning"]);
				} else {
					startServer();
				}
			}, startServer);
		} else {
			startServer();
		}
	}

	function startServer() {
		webServer?.stop();
		webServer = CreateServer(port, openBrowser, onError);
		webServer.setOnRequestHandler(handleRequest);

		function onError(err) {
			if (err === "Server already running") {
				openBrowser();
			} else {
				++port;
				start();
			}
		}
	}

	/**
	 * Requests handler
	 * @param {object} req
	 * @param {string} req.requestId
	 * @param {string} req.path
	 */
	async function handleRequest(req) {
		const reqId = req.requestId;
		let reqPath = req.path.substring(1);

		if (!reqPath || (reqPath.endsWith("/") && reqPath.length === 1)) {
			reqPath = getRelativePath();
		}

		const ext = Url.extname(reqPath);
		let url = null;

		switch (reqPath) {
			case CONSOLE_SCRIPT:
				if (
					isConsole ||
					appSettings.value.console === appSettings.CONSOLE_LEGACY
				) {
					url = `${ASSETS_DIRECTORY}/js/build/console.build.js`;
				} else {
					url = `${DATA_STORAGE}/eruda.js`;
				}
				sendFileContent(url, reqId, "application/javascript");
				break;

			case EXECUTING_SCRIPT: {
				const text = activeFile?.session.getValue() || "";
				sendText(text, reqId, "application/javascript");
				break;
			}

			case MARKDOWN_STYLE:
				url = appSettings.value.markdownStyle;
				if (url) sendFileContent(url, reqId, "text/css");
				else sendText("img {max-width: 100%;}", reqId, "text/css");
				break;

			default:
				sendByExt();
				break;
		}

		async function sendByExt() {
			if (isConsole) {
				if (reqPath === "console.html") {
					sendText(
						mustache.render($_console, {
							CONSOLE_SCRIPT,
							EXECUTING_SCRIPT,
						}),
						reqId,
						MIMETYPE_HTML,
					);
					return;
				}

				if (reqPath === "favicon.ico") {
					sendIco(ASSETS_DIRECTORY, reqId);
					return;
				}
			}

			if (activeFile.mode === "single") {
				if (filename === reqPath) {
					sendText(
						activeFile.session.getValue(),
						reqId,
						mimeType.lookup(filename),
					);
				} else {
					error(reqId);
				}
				return;
			}

			let url = activeFile.uri;

			let file = activeFile.SAFMode === "single" ? activeFile : null;

			if (pathName) {
				const projectFolder = addedFolder[0];

				//set the root folder to the file parent if no project folder is set
				let rootFolder = pathName;
				if (projectFolder !== undefined) {
					rootFolder = projectFolder.url;
				}
				const query = url.split("?")[1];

				//remove the query string if present this is needs to be removed because the url is not valid
				if (rootFolder.startsWith("ftp:") || rootFolder.startsWith("sftp:")) {
					if (rootFolder.includes("?")) {
						rootFolder = rootFolder.split("?")[0];
					}
				}

				url = Url.join(rootFolder, reqPath);

				//attach the ftp query string to the url
				if (query) {
					url = `${url}?${query}`;
				}

				console.log("url", url);

				file = editorManager.getFile(url, "uri");
			} else if (!activeFile.uri) {
				file = activeFile;
			}

			switch (ext) {
				case ".htm":
				case ".html":
					if (file && file.loaded && file.isUnsaved) {
						sendHTML(file.session.getValue(), reqId);
					} else {
						sendFileContent(url, reqId, MIMETYPE_HTML);
					}
					break;

				case ".md":
					if (file) {
						const html = markdownIt({ html: true })
							.use(MarkdownItGitHubAlerts)
							.use(anchor, {
								slugify: (s) =>
									s
										.trim()
										.toLowerCase()
										.replace(/[^a-z0-9]+/g, "-"),
							})
							.render(file.session.getValue());
						const doc = mustache.render($_markdown, {
							html,
							filename,
							MARKDOWN_STYLE,
						});
						sendText(doc, reqId, MIMETYPE_HTML);
					}
					break;

				default:
					if (file && file.loaded && file.isUnsaved) {
						sendText(
							file.session.getValue(),
							reqId,
							mimeType.lookup(file.filename),
						);
					} else if (url) {
						if (reqPath === "favicon.ico") {
							sendIco(ASSETS_DIRECTORY, reqId);
						} else {
							sendFile(url, reqId);
						}
					} else {
						error(reqId);
					}
					break;
			}
		}
	}

	/**
	 * Sends 404 error
	 * @param {string} id
	 */
	function error(id) {
		webServer?.send(id, {
			status: 404,
			body: "File not found!",
		});
	}

	/**
	 * Sends favicon
	 * @param {string} assets
	 * @param {string} reqId
	 */
	function sendIco(assets, reqId) {
		const ico = Url.join(assets, "res/logo/favicon.ico");
		sendFile(ico, reqId);
	}

	/**
	 * Sends HTML file
	 * @param {string} text
	 * @param {string} id
	 */
	function sendHTML(text, id) {
		const js = `<!-- Injected code, this is not present in original code --><meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script class="${uuid}" src="/${CONSOLE_SCRIPT}" crossorigin="anonymous"></script>
    <script class="${uuid}">
      if(window.eruda){
        eruda.init({
          theme: 'dark'
        });

        ${
					target === "inapp"
						? "eruda._shadowRoot.querySelector('.eruda-entry-btn').style.display = 'none';"
						: ""
				}

        sessionStorage.setItem('__console_available', true);
        document.addEventListener('showconsole', function () {eruda.show()});
        document.addEventListener('hideconsole', function () {eruda.hide()});
      }else if(document.querySelector('c-toggler')){
        ${
					target === "inapp" ||
					(target !== "inapp" && !appSettings.value.showConsoleToggler)
						? "document.querySelector('c-toggler').style.display = 'none';"
						: ""
				}
      }
      setTimeout(function(){
        var scripts = document.querySelectorAll('.${uuid}');
        scripts.forEach(function(el){document.head.removeChild(el)});
      }, 0);
    </script><!-- Injected code, this is not present in original code -->`;
		text = text.replace(/><\/script>/g, ' crossorigin="anonymous"></script>');
		const part = text.split("<head>");
		if (part.length === 2) {
			text = `${part[0]}<head>${js}${part[1]}`;
		} else if (/<html>/i.test(text)) {
			text = text.replace("<html>", `<html><head>${js}</head>`);
		} else {
			text = `<head>${js}</head>` + text;
		}
		sendText(text, id);
	}

	/**
	 * Sends file
	 * @param {string} path
	 * @param {string} id
	 * @returns
	 */
	async function sendFile(path, id) {
		if (isLoading) {
			queue.push(() => {
				sendFile(path, id);
			});
			return;
		}

		isLoading = true;
		const protocol = Url.getProtocol(path);
		const ext = Url.extname(path);
		const mimetype = mimeType.lookup(ext);
		if (/s?ftp:/.test(protocol)) {
			const cacheFile = Url.join(
				CACHE_STORAGE,
				protocol.slice(0, -1) + path.hashCode(),
			);
			const fs = fsOperation(path);
			try {
				await fs.readFile(); // Because reading the remote file will create cache file
				path = cacheFile;
			} catch (err) {
				error(id);
				isLoading = false;
				return;
			}
		} else if (protocol === "content:") {
			path = await new Promise((resolve, reject) => {
				sdcard.formatUri(path, resolve, reject);
			});
		} else if (!/^file:/.test(protocol)) {
			const fileContent = await fsOperation(path).readFile();
			const tempFileName = path.hashCode();
			const tempFile = Url.join(CACHE_STORAGE, tempFileName);
			if (!(await fsOperation(tempFile).exists())) {
				await fsOperation(CACHE_STORAGE).createFile(tempFileName, fileContent);
			} else {
				await fsOperation(tempFile).writeFile(fileContent);
			}
			path = tempFile;
		}

		webServer?.send(id, {
			status: 200,
			path,
			headers: {
				"Content-Type": mimetype,
			},
		});

		isLoading = false;
		const action = queue.splice(-1, 1)[0];
		if (typeof action === "function") action();
	}

	/**
	 * Sends file content
	 * @param {string} url
	 * @param {string} id
	 * @param {string} mime
	 * @param {(txt: string) => string} processText
	 * @returns
	 */
	async function sendFileContent(url, id, mime, processText) {
		const fs = fsOperation(url);

		if (!(await fs.exists())) {
			error(id);
			return;
		}

		let text = await fs.readFile(appSettings.value.defaultFileEncoding);
		text = processText ? processText(text) : text;
		if (mime === MIMETYPE_HTML) {
			sendHTML(text, id);
		} else {
			sendText(text, id, mime);
		}
	}

	/**
	 * Sends text
	 * @param {string} text
	 * @param {string} id
	 * @param {string} mimeType
	 * @param {(txt: string) => string} processText
	 */
	function sendText(text, id, mimeType, processText) {
		webServer?.send(id, {
			status: 200,
			body: processText ? processText(text) : text,
			headers: {
				"Content-Type": mimeType || "text/html",
			},
		});
	}

	function getRelativePath() {
		// Get the project url
		const projectFolder = addedFolder[0];

		// Set the root folder to the file parent if no project folder is set
		let rootFolder = pathName;
		if (projectFolder !== undefined) {
			rootFolder = projectFolder.url;
		}

		//make the uri absolute if necessary
		if (
			rootFolder ===
			"content://com.termux.documents/tree/%2Fdata%2Fdata%2Fcom.termux%2Ffiles%2Fhome"
		) {
			rootFolder =
				"content://com.termux.documents/tree/%2Fdata%2Fdata%2Fcom.termux%2Ffiles%2Fhome::/data/data/com.termux/files/home/";
		}

		console.log("rootFolder", rootFolder);
		console.log("pathName", pathName);
		console.log("filename", filename);

		// Parent of the file
		let filePath = pathName;

		if (rootFolder.startsWith("ftp:") || rootFolder.startsWith("sftp:")) {
			if (rootFolder.includes("?")) {
				rootFolder = rootFolder.split("?")[0];
			}
		}

		//remove the query string if present this is needs to be removed because the url is not valid
		if (filePath.startsWith("ftp:") || rootFolder.startsWith("sftp:")) {
			if (filePath.includes("?")) {
				filePath = filePath.split("?")[0];
			}
		}

		// Create full file path
		let temp = Url.join(filePath, filename);

		// Special handling for Termux URIs
		if (temp.includes("com.termux.documents") && temp.includes("::")) {
			try {
				const [, realPath] = temp.split("::");

				// Determine root folder inside :: path
				let rootPath = rootFolder;
				if (rootFolder.includes("::")) {
					rootPath = rootFolder.split("::")[1];
				}

				// Normalize both paths to arrays
				const realParts = realPath.split("/").filter(Boolean);
				const rootParts = rootPath.split("/").filter(Boolean);

				// Find where the paths start to differ
				let diffIndex = 0;
				while (
					diffIndex < realParts.length &&
					diffIndex < rootParts.length &&
					realParts[diffIndex] === rootParts[diffIndex]
				) {
					diffIndex++;
				}

				// Return everything after the common root
				const relativeParts = realParts.slice(diffIndex);
				if (relativeParts.length > 0) {
					return relativeParts.join("/");
				}
			} catch (e) {
				console.error("Error handling Termux URI:", e);
			}
		}

		// Handle other content:// URIs
		if (temp.includes("content://") && temp.includes("::")) {
			try {
				// Get the part after :: which contains the actual file path
				const afterDoubleColon = temp.split("::")[1];

				if (afterDoubleColon) {
					// Extract the rootFolder's content path if it has ::
					let rootFolderPath = rootFolder;
					if (rootFolder.includes("::")) {
						rootFolderPath = rootFolder.split("::")[1];
					}

					// If rootFolder doesn't have ::, try to extract the last part of the path
					if (!rootFolderPath.includes("::")) {
						const rootParts = rootFolder.split("/");
						const lastPart = rootParts[rootParts.length - 1];

						// Check if the lastPart is encoded
						if (lastPart.includes("%3A")) {
							// Try to decode it
							try {
								const decoded = decodeURIComponent(lastPart);
								rootFolderPath = decoded;
							} catch (e) {
								console.error("Error decoding URI component:", e);
								rootFolderPath = lastPart;
							}
						} else {
							rootFolderPath = lastPart;
						}
					}

					// Now find this rootFolderPath in the afterDoubleColon string
					if (afterDoubleColon.includes(rootFolderPath)) {
						// Find where to start the relative path
						const parts = afterDoubleColon.split("/");

						// Find the index of the part that matches or contains rootFolderPath
						let startIndex = -1;
						for (let i = 0; i < parts.length; i++) {
							if (
								parts[i].includes(rootFolderPath) ||
								rootFolderPath.includes(parts[i])
							) {
								startIndex = i;
								break;
							}
						}

						// If we found a matching part, get everything after it
						if (startIndex >= 0 && startIndex < parts.length - 1) {
							return parts.slice(startIndex + 1).join("/");
						}
					}
				}
			} catch (e) {
				console.error("Error parsing content URI:", e);
			}
		}

		// For regular paths or if content:// URI parsing failed
		// Try to find a common prefix between rootFolder and temp
		// and remove it from temp
		try {
			const rootParts = rootFolder.split("/");
			const tempParts = temp.split("/");

			let commonIndex = 0;
			for (let i = 0; i < Math.min(rootParts.length, tempParts.length); i++) {
				if (rootParts[i] === tempParts[i]) {
					commonIndex = i + 1;
				} else {
					break;
				}
			}

			if (commonIndex > 0) {
				return tempParts.slice(commonIndex).join("/");
			}
		} catch (e) {
			console.error("Error finding common path:", e);
		}

		// If all else fails, just return the filename
		if (filename) {
			return filename;
		}

		console.log("Unable to determine relative path, returning full path");
		return temp;
	}

	/**
	 * Opens the preview in browser
	 */
	function openBrowser() {
		let url = "";
		if (pathName === null && !activeFile.location) {
			url = `http://localhost:${port}/__unsaved_file__`;
		} else {
			url = `http://localhost:${port}/${getRelativePath()}`;
		}

		if (target === "browser") {
			system.openInBrowser(url);
			return;
		}

		browser.open(url, isConsole);
	}
}

export default run;
