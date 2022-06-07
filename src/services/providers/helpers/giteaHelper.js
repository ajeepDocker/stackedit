import utils from '../../utils';
import networkSvc from '../../networkSvc';
import store from '../../../store';
import userSvc from '../../userSvc';
import badgeSvc from '../../badgeSvc';
import constants from '../../../data/constants';

const tokenExpirationMargin = 5 * 60 * 1000;

const request = ({ accessToken, serverUrl }, options) => networkSvc.request({
  ...options,
  url: `${serverUrl}/api/v1/${options.url}`,
  headers: {
    ...options.headers || {},
    Authorization: `Bearer ${accessToken}`,
  },
})
  .then(res => res.body);

const getCommitMessage = (name, path) => {
  const message = store.getters['data/computedSettings'].git[name];
  return message.replace(/{{path}}/g, path);
};

/**
 * https://try.gitea.io/api/swagger#/user/userGet
 */
const subPrefix = 'gt';
userSvc.setInfoResolver('gitea', subPrefix, async (sub) => {
  try {
    const [, serverUrl, username] = sub.match(/^(.+)\/([^/]+)$/);
    const user = (await networkSvc.request({
      url: `${serverUrl}/api/v1/users/${username}`,
    })).body;
    const uniqueSub = `${serverUrl}/${user.username}`;

    return {
      id: `${subPrefix}:${uniqueSub}`,
      name: user.username,
      imageUrl: user.avatar_url || '',
    };
  } catch (err) {
    if (err.status !== 404) {
      throw new Error('RETRY');
    }
    throw err;
  }
});

export default {
  subPrefix,

  /**
   * https://docs.gitea.io/en-us/oauth2-provider/
   */
  async startOauth2(
    serverUrl, applicationId, applicationSecret,
    sub = null, silent = false, refreshToken,
  ) {
    let tokenBody;
    if (!silent) {
      // Get an OAuth2 code
      const { code } = await networkSvc.startOauth2(
        `${serverUrl}/login/oauth/authorize`,
        {
          client_id: applicationId,
          response_type: 'code',
          redirect_uri: constants.oauth2RedirectUri,
        },
        silent,
      );
      // Exchange code with token
      tokenBody = (await networkSvc.request({
        method: 'POST',
        url: `${serverUrl}/login/oauth/access_token`,
        body: {
          client_id: applicationId,
          client_secret: applicationSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: constants.oauth2RedirectUri,
        },
      })).body;
    } else {
      // Exchange refreshToken with token
      tokenBody = (await networkSvc.request({
        method: 'POST',
        url: `${serverUrl}/login/oauth/access_token`,
        body: {
          client_id: applicationId,
          client_secret: applicationSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
          redirect_uri: constants.oauth2RedirectUri,
        },
      })).body;
    }

    const accessToken = tokenBody.access_token;

    // Call the user info endpoint
    const user = await request({ accessToken, serverUrl }, {
      url: 'user',
    });
    const uniqueSub = `${serverUrl}/${user.username}`;
    userSvc.addUserInfo({
      id: `${subPrefix}:${uniqueSub}`,
      name: user.username,
      imageUrl: user.avatar_url || '',
    });

    // Check the returned sub consistency
    if (sub && uniqueSub !== sub) {
      throw new Error('Gitea account ID not expected.');
    }

    // Build token object including scopes and sub
    const token = {
      accessToken,
      name: user.username,
      applicationId,
      applicationSecret,
      refreshToken: tokenBody.refresh_token,
      expiresOn: Date.now() + (tokenBody.expires_in * 1000),
      serverUrl,
      sub: uniqueSub,
    };

    // Add token to gitea tokens
    store.dispatch('data/addGiteaToken', token);
    return token;
  },
  // 刷新token
  async refreshToken(token) {
    const {
      serverUrl,
      applicationId,
      applicationSecret,
      sub,
    } = token;
    const lastToken = store.getters['data/giteaTokensBySub'][sub];
    // 兼容旧的没有过期时间
    if (!lastToken.expiresOn) {
      await store.dispatch('modal/open', {
        type: 'providerRedirection',
        name: 'Gitea',
      });
      return this.startOauth2(serverUrl, applicationId, applicationSecret, sub);
    }
    // lastToken is not expired
    if (lastToken.expiresOn > Date.now() + tokenExpirationMargin) {
      return lastToken;
    }

    // existing token is about to expire.
    // Try to get a new token in background
    try {
      return await this.startOauth2(
        serverUrl, applicationId, applicationSecret,
        sub, true, lastToken.refreshToken,
      );
    } catch (err) {
      // If it fails try to popup a window
      if (store.state.offline) {
        throw err;
      }
      await store.dispatch('modal/open', {
        type: 'providerRedirection',
        name: 'Gitea',
      });
      return this.startOauth2(serverUrl, applicationId, applicationSecret, sub);
    }
  },
  async addAccount(serverUrl, applicationId, applicationSecret, sub = null) {
    const token = await this.startOauth2(serverUrl, applicationId, applicationSecret, sub);
    badgeSvc.addBadge('addGiteaAccount');
    return token;
  },

  /**
   * https://try.gitea.io/api/swagger#/repository/repoGet
   */
  async getProjectId({ projectPath, projectId }) {
    if (projectId) {
      return projectId;
    }
    const [, repoFullName] = projectPath.match(/([^/]+\/[^/]+)$/);
    return repoFullName;
  },

  /**
   * https://try.gitea.io/api/swagger#/repository/GetTree
   */
  async getTree({
    token,
    projectId,
    branch,
  }) {
    const refreshedToken = await this.refreshToken(token);
    return request(refreshedToken, {
      url: `repos/${projectId}/git/trees/${branch}`,
      params: {
        recursive: true,
        per_page: 9999,
      },
    });
  },

  /**
   * https://try.gitea.io/api/swagger#/repository/repoGetAllCommits
   */
  async getCommits({
    token,
    projectId,
    branch,
    path,
  }) {
    const refreshedToken = await this.refreshToken(token);
    return request(refreshedToken, {
      url: `repos/${projectId}/commits`,
      params: {
        sha: branch,
        path,
      },
    });
  },

  /**
   * https://try.gitea.io/api/swagger#/repository/repoCreateFile
   * https://try.gitea.io/api/swagger#/repository/repoUpdateFile
   */
  async uploadFile({
    token,
    projectId,
    branch,
    path,
    content,
    sha,
  }) {
    const refreshedToken = await this.refreshToken(token);
    return request(refreshedToken, {
      method: sha ? 'PUT' : 'POST',
      url: `repos/${projectId}/contents/${encodeURIComponent(path)}`,
      body: {
        message: getCommitMessage(sha ? 'updateFileMessage' : 'createFileMessage', path),
        content: utils.encodeBase64(content),
        sha,
        branch,
      },
    });
  },

  /**
   * https://try.gitea.io/api/swagger#/repository/repoDeleteFile
   */
  async removeFile({
    token,
    projectId,
    branch,
    path,
    sha,
  }) {
    const refreshedToken = await this.refreshToken(token);
    return request(refreshedToken, {
      method: 'DELETE',
      url: `repos/${projectId}/contents/${encodeURIComponent(path)}`,
      body: {
        message: getCommitMessage('deleteFileMessage', path),
        sha,
        branch,
      },
    });
  },

  /**
   * https://try.gitea.io/api/swagger#/repository/repoGetContents
   */
  async downloadFile({
    token,
    projectId,
    branch,
    path,
  }) {
    const refreshedToken = await this.refreshToken(token);
    const { sha, content } = await request(refreshedToken, {
      url: `repos/${projectId}/contents/${encodeURIComponent(path)}`,
      params: { ref: branch },
    });
    return {
      sha,
      data: utils.decodeBase64(content),
    };
  },
};