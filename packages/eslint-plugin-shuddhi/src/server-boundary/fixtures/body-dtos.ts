// Cross-file @Body() types for the typed nest-body-dto cases
// (nest-body-dto.test.ts). The decorators are local stand-ins: the rule
// reads decorator NAMES, so it needs no class-validator here.

type FieldDecorator = (...args: unknown[]) => void;

const decorator = (): FieldDecorator => () => undefined;

const IsString = decorator;
const ApiProperty = decorator;

/** Validated: a class-validator decorator on a field. */
export class DecoratedDto {
  @IsString()
  name!: string;
}

/** Inherits its validated field from DecoratedDto. */
export class ChildDto extends DecoratedDto {
  extra!: string;
}

/** A generic DTO class: the pipe sees PageDto and its decorators. */
export class PageDto<T> {
  @IsString()
  cursor!: string;

  items!: T[];
}

/** A generic interface: erased at runtime, whatever its argument. */
export interface Envelope<T> {
  data: T;
}

/** A class, but nothing on it validates. */
export class UndecoratedDto {
  name!: string;
}

/** Documented for Swagger only: still validates nothing. */
export class DocumentedOnlyDto {
  @ApiProperty()
  name!: string;
}

/** An interface: erased at runtime. */
export interface BodyShape {
  name: string;
}

/** A type alias: erased at runtime. */
export type AliasShape = { name: string };
