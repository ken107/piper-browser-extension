
function makeDispatcher(myAddress, handlers) {
    const pendingRequests = new Map();
    return {
        waitForResponse(requestId) {
            let pending = pendingRequests.get(requestId);
            if (!pending)
                pendingRequests.set(requestId, pending = makePending());
            return pending.promise;
        },
        dispatch(message, sender, sendResponse) {
            switch (message.type) {
                case "request": return handleRequest(message, sender, sendResponse);
                case "notification": return handleNotification(message, sender);
                case "response": return handleResponse(message);
            }
        },
        updateHandlers(newHandlers) {
            handlers = newHandlers;
        }
    };
    function makePending() {
        const pending = {};
        pending.promise = new Promise((fulfill, reject) => {
            pending.fulfill = fulfill;
            pending.reject = reject;
        });
        return pending;
    }
    function handleRequest(req, sender, sendResponse) {
        if (req.to == myAddress) {
            if (handlers[req.method]) {
                Promise.resolve()
                    .then(() => handlers[req.method](req.args, sender))
                    .then(result => sendResponse({ type: "response", id: req.id, result, error: undefined }), error => sendResponse({ type: "response", id: req.id, result: undefined, error }));
                //let caller know that sendResponse will be called asynchronously
                return true;
            }
            else {
                console.error("No handler for method", req);
            }
        }
    }
    function handleNotification(ntf, sender) {
        if (ntf.to == myAddress) {
            if (handlers[ntf.method]) {
                Promise.resolve()
                    .then(() => handlers[ntf.method](ntf.args, sender))
                    .catch(error => console.error("Failed to handle notification", ntf, error));
            }
            else {
                console.error("No handler for method", ntf);
            }
        }
    }
    function handleResponse(res) {
        const pending = pendingRequests.get(res.id);
        if (pending) {
            pendingRequests.delete(res.id);
            if (res.error)
                pending.reject(res.error);
            else
                pending.fulfill(res.result);
        }
        else {
            console.error("Stray response", res);
        }
    }
}
