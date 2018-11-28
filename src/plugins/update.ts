import Model from '../dataModel/model';
import { Context, Plugin } from './interface';
import WhereInputPlugin from './whereInput';
import BaseTypePlugin from './baseType';
import ObjectField from '../dataModel/objectField';
import { upperFirst, forEach, get } from 'lodash';
import { ListMutable } from '../dataSource/interface';
import { RelationField } from '../dataModel';
import CreatePlugin from './create';
import { Hook } from '../hooks/interface';

const createObjectInputField = (prefix: string, field: ObjectField, context: Context) => {
  const { root } = context;
  const content: string[] = [];
  forEach(field.getFields(), (nestedField, name) => {
    if (nestedField.isScalar()) {
      content.push(`${name}: ${nestedField.getTypename()}`);
      return;
    }

    if (nestedField instanceof ObjectField) {
      const fieldWithPrefix = `${prefix}${upperFirst(name)}`;
      const typeFields = createObjectInputField(fieldWithPrefix, nestedField, context);
      const objectInputName = `${fieldWithPrefix}UpdateInput`;
      root.addInput(`input ${objectInputName} {${typeFields.join(' ')}}`);
      content.push(`${name}: ${objectInputName}`);
      return;
    }

    // skip relation field
  });
  return content;
};

const createInputField = (
  model: Model,
  context: Context,
  getCreateInputName: (model: Model) => string,
  getWhereInputName: (model: Model) => string,
  getWhereUniqueInputName: (model: Model) => string,
) => {
  const { root } = context;
  const capName = model.getNamings().capitalSingular;
  const fields = model.getFields();
  const content: string[] = [];
  forEach(fields, (field, name) => {
    if (field.isAutoGenerated()) {
      return;
    }

    if (field.isScalar()) {
      content.push(`${name}: ${field.getTypename()}`);
      return;
    }

    if (field instanceof ObjectField) {
      // create input for nested object
      const fieldWithPrefix = `${model.getNamings().capitalSingular}${upperFirst(name)}`;
      const typeFields = createObjectInputField(fieldWithPrefix, field, context);
      const objectInputName = `${fieldWithPrefix}UpdateInput`;
      root.addInput(`input ${objectInputName} {${typeFields.join(' ')}}`);
      content.push(`${name}: ${objectInputName}`);
      return;
    }

    // relation
    // add create, connect, disconnect, delete for relation
    const isRelation = field instanceof RelationField;
    const isList = field.isList();
    if (isRelation && !isList) {
      // to-one
      const relationTo = (field as RelationField).getRelationTo();
      const relationInputName = `${capName}UpdateOneInput`;
      root.addInput(`input ${relationInputName} {
        create: ${getCreateInputName(relationTo)}
        connect: ${getWhereUniqueInputName(relationTo)}
        disconnect: Boolean
        delete: Boolean
      }`);
      content.push(`${name}: ${relationInputName}`);
      return;
    }

    if (isRelation && isList) {
      // to-many
      const relationTo = (field as RelationField).getRelationTo();
      const relationInputName = `${capName}UpdateManyInput`;
      const whereUnique = getWhereUniqueInputName(relationTo);
      root.addInput(`input ${relationInputName} {
        create: [${getCreateInputName(relationTo)}]
        connect: [${whereUnique}]
        disconnect: [${whereUnique}]
        delete: [${whereUnique}]
      }`);
      content.push(`${name}: ${relationInputName}`);
      return;
    }
  });

  return content;
};

export default class UpdatePlugin implements Plugin {
  private whereInputPlugin: WhereInputPlugin;
  private baseTypePlugin: BaseTypePlugin;
  private createPlugin: CreatePlugin;
  private hook: Hook;

  constructor({
    hook,
  }: {
    hook: Hook,
  }) {
    this.hook = hook;
  }

  public setPlugins(plugins: Plugin[]) {
    this.whereInputPlugin = plugins.find(
      plugin => plugin instanceof WhereInputPlugin) as WhereInputPlugin;
    this.baseTypePlugin = plugins.find(
      plugin => plugin instanceof BaseTypePlugin) as BaseTypePlugin;
    this.createPlugin = plugins.find(
        plugin => plugin instanceof CreatePlugin) as CreatePlugin;
  }

  public visitModel(model: Model, context: Context) {
    const { root } = context;
    const modelType = this.baseTypePlugin.getTypename(model);

    // update
    const mutationName = this.getInputName(model);
    const inputName = this.generateUpdateInput(model, context);
    const whereUniqueInput = this.whereInputPlugin.getWhereUniqueInputName(model);
    root.addMutation(`${mutationName}(where: ${whereUniqueInput}, data: ${inputName}!): ${modelType}`);
  }

  public resolveInMutation({model, dataSource}: {model: Model, dataSource: ListMutable}) {
    const mutationName = this.getInputName(model);
    const beforeUpdate = get(this.hook, [model.getName(), 'beforeUpdate']);
    const transformUpdatePayload = get(this.hook, [model.getName(), 'transformUpdatePayload']);
    const afterUpdate = get(this.hook, [model.getName(), 'afterUpdate']);

    return {
      [mutationName]: async (root, args, context) => {
        const whereUnique = this.whereInputPlugin.parseUniqueWhere(args.where);
        if (beforeUpdate) {
          await beforeUpdate(args.where, args.data);
        }
        const data = transformUpdatePayload ? await transformUpdatePayload(args.data) : args.data;
        const updated = await dataSource.update(whereUnique, data);
        if (afterUpdate) {
          await afterUpdate(args.where, data);
        }
        return updated;
      },
    };
  }

  private generateUpdateInput(model: Model, context: Context) {
    const inputName = `${model.getNamings().capitalSingular}UpdateInput`;
    const input = `input ${inputName} {
      ${createInputField(
        model,
        context,
        this.createPlugin.getCreateInputName,
        this.whereInputPlugin.getWhereInputName,
        this.whereInputPlugin.getWhereUniqueInputName,
      )}
    }`;
    context.root.addInput(input);
    return inputName;
  }

  private getInputName(model: Model) {
    return `update${model.getNamings().capitalSingular}`;
  }
}
