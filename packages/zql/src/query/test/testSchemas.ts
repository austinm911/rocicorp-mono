export const issueSchema = {
  tableName: 'issue',
  columns: {
    id: {type: 'string'},
    title: {type: 'string'},
    description: {type: 'string'},
    closed: {type: 'boolean'},
    ownerId: {type: 'string', optional: true},
  },
  primaryKey: ['id'],
  relationships: {
    owner: {
      source: 'ownerId',
      dest: {
        field: 'id',
        schema: () => userSchema,
      },
    },
    comments: {
      source: 'id',
      dest: {
        field: 'issueId',
        schema: () => commentSchema,
      },
    },
    labels: {
      source: 'id',
      junction: {
        source: 'issueId',
        dest: {
          field: 'labelId',
          schema: () => issueLabelSchema,
        },
      },
      dest: {
        field: 'id',
        schema: () => labelSchema,
      },
    },
  },
} as const;

export const issueLabelSchema = {
  tableName: 'issueLabel',
  columns: {
    issueId: {type: 'string'},
    labelId: {type: 'string'},
  },
  primaryKey: ['issueId', 'labelId'],
  relationships: {},
} as const;

export const labelSchema = {
  tableName: 'label',
  columns: {
    id: {type: 'string'},
    name: {type: 'string'},
  },
  primaryKey: ['id'],
  relationships: {
    issues: {
      source: 'id',
      junction: {
        source: 'labelId',
        dest: {
          field: 'issueId',
          schema: issueLabelSchema,
        },
      },
      dest: {
        field: 'id',
        schema: issueSchema,
      },
    },
  },
} as const;

export const commentSchema = {
  tableName: 'comment',
  columns: {
    id: {type: 'string'},
    authorId: {type: 'string'},
    issueId: {type: 'string'},
    text: {type: 'string'},
    createdAt: {type: 'number'},
  },
  primaryKey: ['id'],
  relationships: {
    issue: {
      source: 'issueId',
      dest: {
        field: 'id',
        schema: issueSchema,
      },
    },
    revisions: {
      source: 'id',
      dest: {
        field: 'commentId',
        schema: () => revisionSchema,
      },
    },
    author: {
      source: 'authorId',
      dest: {
        field: 'id',
        schema: () => userSchema,
      },
    },
  },
} as const;

export const revisionSchema = {
  tableName: 'revision',
  columns: {
    id: {type: 'string'},
    authorId: {type: 'string'},
    commentId: {type: 'string'},
    text: {type: 'string'},
  },
  primaryKey: ['id'],
  relationships: {
    comment: {
      source: 'commentId',
      dest: {
        field: 'id',
        schema: commentSchema,
      },
    },
    author: {
      source: 'authorId',
      dest: {
        field: 'id',
        schema: () => userSchema,
      },
    },
  },
} as const;

export const userSchema = {
  tableName: 'user',
  columns: {
    id: {type: 'string'},
    name: {type: 'string'},
    metadata: {type: 'json', optional: true},
  },
  primaryKey: ['id'],
  relationships: {
    issues: {
      source: 'id',
      dest: {
        field: 'ownerId',
        schema: issueSchema,
      },
    },
  },
} as const;

export const schemas = {
  issue: issueSchema,
  issueLabel: issueLabelSchema,
  label: labelSchema,
  comment: commentSchema,
  revision: revisionSchema,
  user: userSchema,
} as const;
