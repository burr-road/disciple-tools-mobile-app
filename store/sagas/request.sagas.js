// adapted from:
//   -- https://www.youtube.com/watch?v=Pg7LgW3TL7A
//   -- https://redux-saga.js.org/docs/advanced/Channels.html

import { take, fork, call, put, race, actionChannel, select } from 'redux-saga/effects';
//import * as Sentry from 'sentry-expo';

function* sendRequest(url, data) {
  let genericErrorResponse = {
    status: 400,
    data: {
      code: '400',
      message: 'Unable to process the request. Please try again later.',
    },
  };

  const request = yield fetch(url, data)
    .then((response) => {
      if (response.status >= 200 && response.status < 300) {
        return response;
      } else {
        throw response;
      }
    })
    .then(async (response) => {
      return response.text().then((responseJSON) => {
        return JSON.parse(responseJSON);
      });
    })
    .then((response) => {
      return {
        status: 200,
        data: response,
      };
    })
    .catch(async (error) => {
      if (typeof error.json === 'function') {
        return error.text().then(
          (errorJSON) => {
            var isHTML = RegExp.prototype.test.bind(/(<([^>]+)>)/i);
            if (isHTML(errorJSON)) {
              // Back-end error response in (HTML)
              //Sentry.captureException(errorJSON);
              return genericErrorResponse;
            } else {
              // Back-end error response in (JSON)
              //Sentry.captureException(errorJSON);
              errorJSON = JSON.parse(errorJSON);
              return {
                status: errorJSON.data && errorJSON.data.status ? errorJSON.data.status : '',
                data: {
                  code: errorJSON.code,
                  message: errorJSON.message,
                },
              };
            }
          },
          (error) => {
            //Sentry.captureException(error);
            // Catch if 'text() method' or 'JSON.parse()' throw error
            return genericErrorResponse;
          },
        );
      } else {
        //Sentry.captureException(error);
        // Catch if 'text() method' or 'JSON.parse()' throw error
        return genericErrorResponse;
      }
    });
  return request;
}

function* processRequest(request) {
  let oldID;
  let requestCopy = { ...request };

  if (requestCopy.data.body) {
    const jsonParseBody = JSON.parse(requestCopy.data.body);
    // request has ID and the id its Autogenerated

    if (jsonParseBody.ID) {
      if (isNaN(jsonParseBody.ID)) {
        oldID = jsonParseBody.ID;
      }
      delete jsonParseBody.ID;
      requestCopy = {
        ...requestCopy,
        data: {
          ...requestCopy.data,
          body: JSON.stringify(jsonParseBody),
        },
      };
    }
  }
  const { response } = yield race({
    response: call(sendRequest, requestCopy.url, requestCopy.data),
  });
  if (response) {
    if (requestCopy.action) {
      yield put({ type: requestCopy.action, payload: oldID ? { ...response, oldID } : response });
    }
    // Dispatch action 'RESPONSE' to remove request from queue
    yield put({ type: 'RESPONSE', payload: request });
  }
}

export default function* requestSaga() {
  // buffer all incoming requests
  const requestChannel = yield actionChannel('REQUEST');
  while (true) {
    const { request } = yield race({
      request: take(requestChannel),
    });
    const isConnected = yield select((state) => state.networkConnectivityReducer.isConnected);
    const localGetById = {
      value: null,
      isLocal: false,
    };
    if (request.payload.data.method === 'GET' && request.payload.action.includes('GETBYID')) {
      let id = request.payload.url.split('/');
      id = id[id.length - 1];
      localGetById.value = id;
      if (isNaN(id)) {
        localGetById.isLocal = true;
      }
    }
    if (!isConnected || localGetById.isLocal) {
      // Get last request
      const payload = yield select((state) => state.requestReducer.currentAction);
      // OFFLINE request
      if (payload) {
        // Prevent error when app lost connection
        if (payload.data.method) {
          if (payload.data.method === 'POST' && payload.action.includes('SAVE')) {
            // Offline entity creation (send "last request" as response)
            /* eslint-disable */
            yield put({ type: payload.action, payload: JSON.parse(payload.data.body) });
            /* eslint-enable */
          }
          if (payload.data.method === 'GET' && payload.action.includes('GETBYID')) {
            yield put({
              type: payload.action,
              payload: { data: { ID: localGetById.value, isOffline: true }, status: 200 },
            });
          }
          if (payload.data.method === 'GET' && payload.action.includes('GETALL')) {
            const entityName = payload.action.substr(0, payload.action.indexOf('_')).toLowerCase();
            const list = yield select((state) => state[`${entityName}Reducer`][`${entityName}`]);
            yield put({ type: payload.action, payload: { data: { posts: list }, status: 200 } });
          }
          if (payload.data.method === 'GET' && payload.action.includes('GET_LOCATIONS')) {
            const entityName = payload.action.substr(0, payload.action.indexOf('_')).toLowerCase();
            const list = yield select((state) => state[`${entityName}Reducer`]['geonames']);
            yield put({
              type: payload.action,
              payload: { data: { location_grid: list }, status: 200 },
            });
          }
          if (payload.data.method === 'POST' && payload.action.includes('UPDATE_USER_INFO')) {
            yield put({
              type: payload.action,
              payload: { data: {}, status: 200 },
            });
          }
          if (payload.data.method === 'DELETE' && payload.action.includes('DELETE')) {
            // Offline entity delete (send "last request" as response)
            /* eslint-disable */
            yield put({ type: payload.action, payload: { data: true, status: 200 } });
            /* eslint-enable */
          }
        }
      }
    } else if (request) {
      // ONLINE request
      // Get current queue, compare it with last request (if exist, fork it)
      const queue = yield select((state) => state.requestReducer.queue);
      let requestIndex;
      if (request.payload.data.method === 'POST') {
        requestIndex = queue.findIndex(
          (requestQueue) =>
            requestQueue.action === request.payload.action &&
            requestQueue.url === request.payload.url &&
            requestQueue.data.method === request.payload.data.method &&
            JSON.parse(requestQueue.data.body).ID === JSON.parse(request.payload.data.body).ID,
        );
      } else {
        requestIndex = queue.findIndex(
          (requestQueue) =>
            requestQueue.action === request.payload.action &&
            requestQueue.url === request.payload.url &&
            requestQueue.data.method === request.payload.data.method,
        );
      }
      if (requestIndex > -1) {
        yield fork(processRequest, queue[requestIndex]);
      }
    }
  }
}
