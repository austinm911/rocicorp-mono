import {createReflectServer} from '@rocicorp/reflect-server';
import {Env, mutators, setEnv} from '../shared/mutators';
import {orchestratorMutators} from '../shared/orchestrator-mutators';
import renderModule from '../../vendor/renderer/renderer_bg.wasm';
import initRenderer from '../../vendor/renderer';

setEnv(Env.SERVER, async () => {
  await initRenderer(renderModule);
});

const authHandler = async (auth: string, roomID: string) => {
  // Note a real implementation should use signed and encrypted auth tokens,
  // or store the auth tokens in a session database for validation.
  const authJson = JSON.parse(auth);
  if (!authJson) {
    throw Error('Empty auth');
  }
  if (authJson.roomID !== roomID) {
    throw new Error('incorrect roomID');
  }
  if (!authJson.userID || typeof authJson.userID !== 'string') {
    throw new Error('Missing userID');
  }
  return {
    userID: authJson.userID,
  };
};

const allMutators = {...mutators, ...orchestratorMutators};
const mCount = (o: object) => Object.keys(o).length;
if (mCount(mutators) + mCount(orchestratorMutators) !== mCount(allMutators)) {
  throw new Error(
    'Invalid mutators - all mutator names must be unique across frontend and orchestrator clients',
  );
}

const {worker, RoomDO, AuthDO} = createReflectServer({
  mutators: allMutators,
  authHandler,
  disconnectHandler: async write => {
    console.log(`${write.clientID} disconnected. Cleaning up...`);
    await mutators.removeActor(write, write.clientID);
    await orchestratorMutators.removeOchestratorActor(write, write.clientID);
  },
  getLogLevel: () => 'error',
  allowUnconfirmedWrites: true,
});

export {worker as default, RoomDO, AuthDO};
